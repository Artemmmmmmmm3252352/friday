from __future__ import annotations

import json
import os
import time
import traceback
from dataclasses import dataclass
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

try:
    from beamngpy import BeamNGpy
except Exception as import_error:  # pragma: no cover
    BeamNGpy = None
    BEAMNGPY_IMPORT_ERROR = str(import_error)
else:  # pragma: no cover
    BEAMNGPY_IMPORT_ERROR = None

HOST = os.environ.get("FRIDAY_BEAMNG_HOST", "127.0.0.1")
PORT = int(os.environ.get("FRIDAY_BEAMNG_PORT", "32145"))
BRIDGE_VERSION = "3"
SUPPORTED_COMMANDS = ["traffic", "aggressive_traffic", "random", "span", "stop", "disable", "lane_on", "lane_off", "go_to_place"]
CONNECT_READY_TIMEOUT_SECONDS = float(os.environ.get("FRIDAY_BEAMNG_READY_TIMEOUT", "15"))
CONNECT_POLL_INTERVAL_SECONDS = 0.5
LOAD_WORLD_MESSAGE = (
    "BeamNG is running, but no loaded map and active vehicle are ready yet. "
    "Open any map, wait for the vehicle to spawn, then connect again."
)


@dataclass
class RuntimeState:
    bridge_status: str = "ready"
    python_status: str = "ready"
    install_status: str = "missing"
    install_path: str | None = None
    game_running: bool = False
    connected: bool = False
    active_mode: str | None = None
    drive_in_lane: bool | None = None
    last_resolved_place: str | None = None
    last_error: str | None = None
    detail: str = "BeamNG bridge idle."
    vehicle_id: str | None = None
    beamngpy_installed: bool = BeamNGpy is not None
    beamng: Any = None
    vehicle: Any = None
    scenario: Any = None


STATE = RuntimeState(
    python_status="ready" if BeamNGpy is not None else "error",
    detail="BeamNG bridge ready." if BeamNGpy is not None else "beamngpy is not installed.",
)


class BeamngBridgeHandler(BaseHTTPRequestHandler):
    server_version = "FridayBeamngBridge/1.0"

    def do_GET(self) -> None:  # noqa: N802
        if self.path == "/health":
            self._send_json(
                {
                    "ok": True,
                    "bridgeStatus": STATE.bridge_status,
                    "pythonStatus": STATE.python_status,
                    "beamngpyInstalled": STATE.beamngpy_installed,
                    "bridgeVersion": BRIDGE_VERSION,
                    "supportedCommands": SUPPORTED_COMMANDS,
                    "connected": STATE.connected,
                    "gameRunning": STATE.game_running,
                    "lastError": STATE.last_error,
                    "detail": STATE.detail,
                }
            )
            return

        if self.path == "/state":
            self._send_json(serialize_state())
            return

        if self.path == "/waypoints":
            self._send_json({"waypoints": list_waypoints()})
            return

        self._send_error(HTTPStatus.NOT_FOUND, "Unknown endpoint.")

    def do_POST(self) -> None:  # noqa: N802
        payload = self._read_json()
        if self.path == "/connect":
            self._send_json(connect(payload))
            return

        if self.path == "/disconnect":
            self._send_json(disconnect())
            return

        if self.path == "/command":
            self._send_json(execute_command(payload))
            return

        self._send_error(HTTPStatus.NOT_FOUND, "Unknown endpoint.")

    def log_message(self, format: str, *args: Any) -> None:  # noqa: A003
        print(format % args)

    def _read_json(self) -> dict[str, Any]:
        length = int(self.headers.get("Content-Length", "0"))
        if length <= 0:
            return {}
        raw = self.rfile.read(length)
        try:
            return json.loads(raw.decode("utf-8"))
        except json.JSONDecodeError:
            return {}

    def _send_json(self, payload: dict[str, Any], status: HTTPStatus = HTTPStatus.OK) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_error(self, status: HTTPStatus, message: str) -> None:
        self._send_json({"error": message}, status=status)


def connect(payload: dict[str, Any]) -> dict[str, Any]:
    game_path = str(payload.get("gamePath") or "").strip()
    auto_launch = bool(payload.get("autoLaunch"))
    requested_vehicle_id = str(payload.get("defaultVehicleId") or "").strip() or "ego"

    if BeamNGpy is None:
        STATE.bridge_status = "error"
        STATE.python_status = "error"
        STATE.last_error = f"beamngpy is not installed: {BEAMNGPY_IMPORT_ERROR}"
        STATE.detail = STATE.last_error
        return serialize_state()

    if not game_path:
        STATE.install_status = "missing"
        STATE.last_error = "BeamNG path is missing."
        STATE.detail = STATE.last_error
        return serialize_state()

    root = Path(game_path)
    exe_path = root / "Bin64" / "BeamNG.drive.x64.exe"
    if not root.exists() or not exe_path.exists():
        STATE.install_status = "invalid"
        STATE.install_path = str(root)
        STATE.last_error = "BeamNG.drive.x64.exe was not found in Bin64."
        STATE.detail = STATE.last_error
        return serialize_state()

    try:
        beamng = BeamNGpy("localhost", 64256, home=str(root), quit_on_close=False)
        beamng.open(launch=auto_launch)
        scenario, vehicle, vehicle_id = wait_for_loaded_world(beamng, requested_vehicle_id)
        if vehicle is None or not vehicle_id:
            try:
                beamng.disconnect()
            except Exception:
                pass

            STATE.bridge_status = "error"
            STATE.python_status = "ready"
            STATE.install_status = "valid"
            STATE.install_path = str(root)
            STATE.game_running = True
            STATE.connected = False
            STATE.vehicle_id = None
            STATE.last_error = LOAD_WORLD_MESSAGE
            STATE.detail = LOAD_WORLD_MESSAGE
            STATE.beamng = None
            STATE.vehicle = None
            STATE.scenario = None
            return serialize_state()

        STATE.bridge_status = "ready"
        STATE.python_status = "ready"
        STATE.install_status = "valid"
        STATE.install_path = str(root)
        STATE.game_running = True
        STATE.connected = True
        STATE.vehicle_id = vehicle_id
        STATE.detail = (
            "Connected to BeamNG."
            if scenario is not None
            else "Connected to BeamNG. Scenario metadata is not available yet, so waypoint scan may stay empty."
        )
        STATE.last_error = None
        STATE.beamng = beamng
        STATE.vehicle = vehicle
        STATE.scenario = scenario
        return serialize_state()
    except Exception as error:  # pragma: no cover
        return fail(normalize_connect_error_message(error, auto_launch))


def disconnect() -> dict[str, Any]:
    try:
        if STATE.vehicle is not None:
            try:
                STATE.vehicle.disconnect()
            except Exception:
                pass
        if STATE.beamng is not None:
            try:
                STATE.beamng.disconnect()
            except Exception:
                pass
        STATE.game_running = False
        STATE.connected = False
        STATE.active_mode = None
        STATE.detail = "Disconnected from BeamNG."
        STATE.last_error = None
        STATE.vehicle = None
        STATE.beamng = None
        STATE.scenario = None
        return serialize_state()
    except Exception as error:  # pragma: no cover
        return fail(str(error))


def execute_command(payload: dict[str, Any]) -> dict[str, Any]:
    command = payload.get("command") or {}
    command_type = str(command.get("type") or "").strip()
    if not STATE.connected or STATE.vehicle is None:
        return fail("BeamNG is not connected.")

    try:
        if command_type == "traffic":
            STATE.vehicle.ai.set_mode("traffic")
            STATE.vehicle.ai.set_aggression(0.35)
            STATE.vehicle.ai.drive_in_lane(True)
            STATE.active_mode = "traffic"
            STATE.detail = "BeamNG traffic autopilot is active."
        elif command_type == "aggressive_traffic":
            STATE.vehicle.ai.set_mode("traffic")
            STATE.vehicle.ai.set_aggression(0.95)
            STATE.vehicle.ai.drive_in_lane(False)
            STATE.active_mode = "aggressive_traffic"
            STATE.drive_in_lane = False
            STATE.detail = "BeamNG AI is driving in aggressive traffic mode."
        elif command_type == "random":
            STATE.vehicle.ai.set_mode("random")
            STATE.vehicle.ai.set_aggression(0.6)
            STATE.active_mode = "random"
            STATE.detail = "BeamNG AI is roaming the map using random destinations."
        elif command_type == "span":
            STATE.vehicle.ai.set_mode("span")
            STATE.vehicle.ai.set_aggression(0.55)
            STATE.active_mode = "span"
            STATE.detail = "BeamNG AI is driving across the road network."
        elif command_type == "stop":
            STATE.vehicle.ai.set_mode("stopping")
            STATE.active_mode = "stopping"
            STATE.detail = "BeamNG AI is stopping the vehicle."
        elif command_type == "disable":
            STATE.vehicle.ai.set_mode("disabled")
            STATE.active_mode = "disabled"
            STATE.detail = "BeamNG AI is disabled."
        elif command_type == "lane_on":
            if STATE.active_mode in (None, "disabled", "stopping"):
                STATE.vehicle.ai.set_mode("traffic")
                STATE.active_mode = "traffic"
            STATE.vehicle.ai.drive_in_lane(True)
            STATE.drive_in_lane = True
            STATE.detail = "BeamNG AI lane keeping is enabled and traffic driving is active."
        elif command_type == "lane_off":
            if STATE.active_mode in (None, "disabled", "stopping"):
                STATE.vehicle.ai.set_mode("traffic")
                STATE.active_mode = "traffic"
            STATE.vehicle.ai.drive_in_lane(False)
            STATE.drive_in_lane = False
            STATE.detail = "BeamNG AI can now leave the lane when needed."
        elif command_type == "go_to_place":
            waypoint_id = str(payload.get("waypointId") or "").strip()
            place_name = str(payload.get("placeName") or "").strip()
            if not waypoint_id:
                raise RuntimeError("Waypoint id is required.")
            STATE.vehicle.ai.set_mode("manual")
            STATE.vehicle.ai.set_aggression(0.55)
            STATE.vehicle.ai.set_waypoint(waypoint_id)
            STATE.active_mode = "manual"
            STATE.last_resolved_place = place_name or waypoint_id
            STATE.detail = f"BeamNG AI is driving to {STATE.last_resolved_place}."
        else:
            raise RuntimeError("Unsupported command type.")

        STATE.last_error = None
        STATE.game_running = True
        return serialize_state()
    except Exception as error:  # pragma: no cover
        return fail(str(error))


def list_waypoints() -> list[dict[str, Any]]:
    if not STATE.connected or STATE.beamng is None:
        return []

    try:
        scenario = STATE.scenario or STATE.beamng.scenario.get_current(connect=False)
        STATE.scenario = scenario
        waypoints = scenario.find_waypoints()
        return [
            {
                "id": str(getattr(waypoint, "id", "") or getattr(waypoint, "name", "") or ""),
                "name": str(getattr(waypoint, "name", "") or getattr(waypoint, "id", "") or ""),
            }
            for waypoint in waypoints
        ]
    except Exception:  # pragma: no cover
        return []


def fail(message: str) -> dict[str, Any]:
    STATE.bridge_status = "error"
    STATE.last_error = message
    STATE.detail = message
    return serialize_state()


def wait_for_loaded_world(
    beamng: Any,
    requested_vehicle_id: str,
) -> tuple[Any | None, Any | None, str | None]:
    deadline = time.monotonic() + CONNECT_READY_TIMEOUT_SECONDS

    while time.monotonic() < deadline:
        scenario = get_current_scenario(beamng)
        vehicles = get_current_vehicles(beamng)
        vehicle_id = resolve_vehicle_id(beamng, vehicles, requested_vehicle_id)

        if vehicle_id and vehicle_id in vehicles:
            vehicle = vehicles[vehicle_id]
            try:
                vehicle.connect(beamng)
                return scenario, vehicle, vehicle_id
            except Exception:
                pass

        time.sleep(CONNECT_POLL_INTERVAL_SECONDS)

    return None, None, None


def get_current_scenario(beamng: Any) -> Any | None:
    try:
        return beamng.scenario.get_current(connect=False)
    except Exception:
        return None


def get_current_vehicles(beamng: Any) -> dict[str, Any]:
    try:
        vehicles = beamng.vehicles.get_current()
        return vehicles if isinstance(vehicles, dict) else {}
    except Exception:
        return {}


def resolve_vehicle_id(beamng: Any, vehicles: dict[str, Any], requested_vehicle_id: str) -> str | None:
    try:
        player_vehicle = beamng.vehicles.get_player_vehicle_id()
    except Exception:
        player_vehicle = {}

    player_vehicle_id = str(player_vehicle.get("vid") or "")
    if player_vehicle_id and player_vehicle_id in vehicles:
        return player_vehicle_id

    if requested_vehicle_id and requested_vehicle_id in vehicles:
        return requested_vehicle_id

    if vehicles:
        return next(iter(vehicles.keys()))

    return None


def normalize_connect_error_message(error: Exception, auto_launch: bool) -> str:
    message = str(error).strip()
    if "Error connecting to BeamNG.tech" in message:
        if not auto_launch:
            return (
                "Friday could not attach to the already running BeamNG session. "
                "Enable auto-launch, close BeamNG, then let Friday start the game and connect again."
            )
        return (
            "BeamNG API did not become ready in time. Open any map, wait for the vehicle to spawn, "
            "then click Connect again."
        )

    if "No scenario loaded" in message:
        return LOAD_WORLD_MESSAGE

    return message or "BeamNG connection failed."


def serialize_state() -> dict[str, Any]:
    return {
        "bridgeStatus": STATE.bridge_status,
        "pythonStatus": STATE.python_status,
        "installStatus": STATE.install_status,
        "installPath": STATE.install_path,
        "gameRunning": STATE.game_running,
        "connected": STATE.connected,
        "activeMode": STATE.active_mode,
        "driveInLane": STATE.drive_in_lane,
        "lastResolvedPlace": STATE.last_resolved_place,
        "lastError": STATE.last_error,
        "detail": STATE.detail,
        "vehicleId": STATE.vehicle_id,
        "beamngpyInstalled": STATE.beamngpy_installed,
        "bridgeVersion": BRIDGE_VERSION,
        "supportedCommands": SUPPORTED_COMMANDS,
    }


def main() -> None:
    server = ThreadingHTTPServer((HOST, PORT), BeamngBridgeHandler)
    print(f"BeamNG bridge listening on {HOST}:{PORT}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:  # pragma: no cover
        pass
    finally:
        disconnect()
        server.server_close()


if __name__ == "__main__":
    try:
        main()
    except Exception:  # pragma: no cover
        traceback.print_exc()
        raise
