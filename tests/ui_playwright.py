#!/usr/bin/env python3
"""Browser-level smoke coverage for the real Hacker's Lair local service."""

from __future__ import annotations

import json
import os
from pathlib import Path
import re
import shutil
import socket
import subprocess
import tempfile
import threading
import time
import urllib.request

from playwright.sync_api import Error as PlaywrightError
from playwright.sync_api import expect, sync_playwright


ROOT = Path(__file__).resolve().parent.parent
OUTPUT_DIRECTORY = ROOT / "out"
IDENTITY_TIMEOUT_SECONDS = 15


def free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.bind(("127.0.0.1", 0))
        return int(probe.getsockname()[1])


class ListeningFixture:
    def __init__(self) -> None:
        self.socket = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.socket.bind(("127.0.0.1", 0))
        self.socket.listen()
        self.port = int(self.socket.getsockname()[1])
        self._closed = threading.Event()
        self._thread = threading.Thread(target=self._accept_connections, daemon=True)

    def _accept_connections(self) -> None:
        self.socket.settimeout(0.2)
        while not self._closed.is_set():
            try:
                connection, _address = self.socket.accept()
            except (TimeoutError, socket.timeout):
                continue
            except OSError:
                return
            connection.close()

    def __enter__(self) -> "ListeningFixture":
        self._thread.start()
        return self

    def __exit__(self, *_args: object) -> None:
        self._closed.set()
        self.socket.close()
        self._thread.join(timeout=1)


def wait_for_identity(identity_file: Path, process: subprocess.Popen[bytes]) -> dict:
    deadline = time.monotonic() + IDENTITY_TIMEOUT_SECONDS
    last_error: Exception | None = None
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise RuntimeError(f"Local service exited with code {process.returncode}.")
        try:
            identity = json.loads(identity_file.read_text(encoding="utf-8"))
            with urllib.request.urlopen(
                f"http://127.0.0.1:{identity['port']}/api/identity",
                timeout=1,
            ) as response:
                actual = json.loads(response.read().decode("utf-8"))
            if actual["app"] == "hackers-lair" and actual["nonce"] == identity["nonce"]:
                return identity
        except (OSError, KeyError, ValueError) as error:
            last_error = error
        time.sleep(0.1)
    raise RuntimeError(f"Local service identity was not ready: {last_error}")


def shutdown_service(identity: dict) -> None:
    request = urllib.request.Request(
        f"http://127.0.0.1:{identity['port']}/api/service/shutdown",
        data=b"{}",
        method="POST",
        headers={
            "Content-Type": "application/json",
            "X-Lair-Token": identity["token"],
        },
    )
    with urllib.request.urlopen(request, timeout=3):
        pass


def write_projects(data_directory: Path, projects: list[dict]) -> None:
    config = {
        "configVersion": 1,
        "$schema": "./projects.schema.json",
        "projects": projects,
    }
    (data_directory / "projects.json").write_text(
        json.dumps(config, indent=2),
        encoding="utf-8",
    )


def write_script_fixture(data_directory: Path) -> str:
    scripts_directory = data_directory / "script-fixtures"
    scripts_directory.mkdir()
    script_name = "ui-smoke-script.au3"
    (scripts_directory / script_name).write_text(
        "; Compact action tray UI fixture.\n",
        encoding="utf-8",
    )
    config = {
        "configVersion": 1,
        "scriptsDir": str(scripts_directory),
        "autoItExe": "",
        "descriptions": {
            script_name: "Verify the compact Scripts action tray.",
        },
    }
    (data_directory / "scripts.json").write_text(
        json.dumps(config, indent=2),
        encoding="utf-8",
    )
    return script_name


def project_fixture(
    *,
    name: str,
    directory: Path,
    port: int,
    component_name: str,
) -> dict:
    return {
        "name": name,
        "type": "Node",
        "components": [
            {
                "name": component_name,
                "role": "frontend",
                "cwd": str(directory),
                "command": "node -e \"setInterval(() => {}, 1000)\"",
                "match": f"ui-smoke-{component_name}",
                "port": port,
                "detectByPort": True,
            }
        ],
    }


def assert_first_run_setup(page) -> None:
    dialog = page.get_by_role("dialog", name="Commission Your Lair")
    expect(dialog).to_be_visible()
    for section in ["Targets", "Skills", "Automation", "Local Models"]:
        expect(dialog.get_by_role("checkbox", name=section, exact=True)).to_be_checked()
    expect(dialog.get_by_text("One complete prompt", exact=True)).to_be_visible()
    expect(dialog.locator("#firstRunSetupPrompt")).to_contain_text(
        "Set up the selected Hacker's Lair areas for this machine"
    )
    expect(dialog.locator("#firstRunSetupPrompt")).to_contain_text("Local Models")
    expect(dialog.locator("pre")).to_have_count(1)
    expect(dialog).to_contain_text("Settings → Agent Prompts")
    dialog.get_by_role("checkbox", name="Local Models", exact=True).uncheck()
    expect(dialog.locator("#firstRunSetupPrompt")).not_to_contain_text(
        "Set up Hacker's Lair Local Models"
    )
    dialog.get_by_role("checkbox", name="Skills", exact=True).uncheck()
    expect(dialog.locator("#firstRunSetupPrompt")).not_to_contain_text(
        "canonical workspace skill directory"
    )
    dialog.get_by_role("checkbox", name="Local Models", exact=True).check()
    dialog.get_by_role("checkbox", name="Skills", exact=True).check()
    dialog.get_by_role("button", name="Copy Full Setup Prompt", exact=True).click()
    expect(
        dialog.get_by_role("button", name="Copied · Paste Into Your Agent", exact=True)
    ).to_be_visible()
    OUTPUT_DIRECTORY.mkdir(exist_ok=True)
    page.screenshot(
        path=str(OUTPUT_DIRECTORY / "first-run-setup-1440x900.png"),
        full_page=False,
    )
    page.set_viewport_size({"width": 900, "height": 620})
    expect(dialog).to_be_visible()
    assert not page.evaluate(
        "document.documentElement.scrollWidth > document.documentElement.clientWidth"
    ), "First-run setup has horizontal overflow at 900x620."
    page.set_viewport_size({"width": 1440, "height": 900})
    dialog.get_by_role("button", name="Close first-run setup").click()
    expect(dialog).to_be_hidden()


def assert_full_motion_canvas_settles(page) -> None:
    page.evaluate(
        """() => {
          window.__signalRainPaints = 0;
          window.__originalCanvasFillText = CanvasRenderingContext2D.prototype.fillText;
          CanvasRenderingContext2D.prototype.fillText = function(...args) {
            if (this.canvas?.id === 'signalRain') window.__signalRainPaints += 1;
            return window.__originalCanvasFillText.apply(this, args);
          };
          applyUiPreferences({ ...state.uiPreferences, motion: 'full' });
        }"""
    )
    page.wait_for_timeout(250)
    settled_paints = page.evaluate("window.__signalRainPaints")
    page.wait_for_timeout(1_250)
    final_paints = page.evaluate("window.__signalRainPaints")
    assert final_paints == settled_paints, (
        "Motion On continuously repainted the full-window signal canvas: "
        f"{final_paints - settled_paints} additional glyph paints after settling."
    )
    page.evaluate(
        """() => {
          CanvasRenderingContext2D.prototype.fillText = window.__originalCanvasFillText;
        }"""
    )


def assert_empty_state(page) -> None:
    empty_state = page.locator("#emptyState")
    expect(empty_state).to_be_visible()
    expect(empty_state).to_contain_text("No targets loaded")
    recovery = empty_state.get_by_role("region", name="Target registry recovery")
    expect(recovery).to_contain_text("Your project folders may still be intact")
    expect(recovery.locator("pre")).to_contain_text("prior valid projects.json")
    OUTPUT_DIRECTORY.mkdir(exist_ok=True)
    page.screenshot(
        path=str(OUTPUT_DIRECTORY / "target-recovery-1440x900.png"),
        full_page=False,
    )
    recovery.get_by_role("button", name="Copy recovery prompt", exact=True).click()
    expect(recovery.get_by_role("button", name="Copied", exact=True)).to_be_visible()


def assert_project_editor_controls(page, selected_folder: Path) -> None:
    page.get_by_role("button", name="Add Project").click()
    editor = page.locator("#projectEditor")
    expect(editor).to_be_visible()
    page.get_by_role("button", name="Close project editor").click()
    expect(editor).to_be_hidden()

    page.route(
        "**/api/dialog/workspace-folders",
        lambda route: route.fulfill(json={"folders": [str(selected_folder)]}),
    )
    page.get_by_role("button", name="Add Project").click()
    editor.get_by_role("button", name="Choose Folder").click()
    expect(editor.locator('[data-editor-field="cwd"]')).to_have_value(str(selected_folder))
    editor.get_by_role("button", name="Cancel").click()
    expect(editor).to_be_hidden()
    page.unroute("**/api/dialog/workspace-folders")


def assert_project_port_conflict(
    page,
    selected_folder: Path,
    occupied_port: int,
    console_errors: list[str],
) -> None:
    page.get_by_role("button", name="Add Project").click()
    editor = page.locator("#projectEditor")
    editor.locator("#editorProjectName").fill("Occupied Port Fixture")
    editor.locator('[data-editor-field="name"]').fill("web")
    editor.locator('[data-editor-field="cwd"]').fill(str(selected_folder))
    editor.locator('[data-editor-field="command"]').fill("npm run dev")
    editor.locator('[data-editor-field="ports"]').fill(str(occupied_port))
    editor.get_by_role("button", name="Save Project").click()

    conflict = editor.locator("#projectEditorError")
    expect(conflict).to_contain_text(f"Port {occupied_port} is occupied by")
    expect(conflict).to_contain_text("PID")
    expect(editor).to_be_visible()
    editor.get_by_role("button", name="Cancel").click()
    expect(editor).to_be_hidden()
    expected_network_errors = [
        error
        for error in console_errors
        if "Failed to load resource" in error and "409" in error
    ]
    assert len(expected_network_errors) == 1
    console_errors.remove(expected_network_errors[0])


def assert_target_states(page, live_port: int, dormant_port: int) -> None:
    page.reload(wait_until="networkidle")
    live = page.locator('[data-card-kind="project"][data-name="Live Fixture"]')
    dormant = page.locator('[data-card-kind="project"][data-name="Dormant Fixture"]')
    expect(live).to_be_visible(timeout=15_000)
    expect(dormant).to_be_visible(timeout=15_000)
    expect(live).to_have_class(re.compile(r"\blive\b"))
    expect(dormant).to_have_class(re.compile(r"\bdormant\b.*\bcompact\b"))
    expect(live.get_by_text("DETECTED", exact=True)).to_be_visible()
    expect(live.get_by_text(f"localhost:{live_port}", exact=True)).to_be_visible()
    expect(dormant.get_by_text("PORTS", exact=True)).to_be_visible()
    expect(dormant.locator(".configured-port-chip")).to_have_text(f":{dormant_port}")
    expect(dormant.get_by_text("DETECTED", exact=True)).to_have_count(0)

    live_actions = live.locator(".action-cluster .action")
    expect(live_actions).to_have_count(1)
    expect(live_actions).to_have_text("TERMINATE")
    expect(live_actions).to_be_enabled()
    expect(live.get_by_role("button", name="INITIATE", exact=True)).to_have_count(0)

    dormant_actions = dormant.locator(".action-cluster .action")
    expect(dormant_actions).to_have_count(1)
    expect(dormant_actions).to_have_text("INITIATE")
    expect(dormant_actions).to_be_enabled()
    expect(dormant.get_by_role("button", name="TERMINATE", exact=True)).to_have_count(0)

    for card, actions in ((live, live_actions), (dormant, dormant_actions)):
        tray_box = card.locator(".action-cluster").bounding_box()
        action_box = actions.bounding_box()
        assert tray_box is not None and action_box is not None
        assert tray_box["width"] <= action_box["width"] + 20

    assert "N/A" not in page.locator("body").inner_text()


def assert_local_model_controls(page) -> None:
    active_model: dict[str, str | None] = {"id": None}
    setup_ready = {"value": False}
    models = [
        {
            "id": "qwen3-coder-next",
            "name": "Qwen3 Coder Next",
            "quant": "UD-Q3_K_XL",
            "generationTokensPerSecond": 28.22,
            "source": "unsloth/Qwen3-Coder-Next-GGUF",
            "modelFile": "Qwen3-Coder-Next-UD-Q3_K_XL.gguf",
        },
        {
            "id": "qwen3.6-35b-a3b",
            "name": "Qwen3.6 35B A3B",
            "quant": "UD-Q6_K",
            "generationTokensPerSecond": 26.54,
            "source": "unsloth/Qwen3.6-35B-A3B-GGUF",
            "modelFile": "Qwen3.6-35B-A3B-UD-Q6_K.gguf",
        },
    ]

    def payload() -> dict:
        return {
            "supported": True,
            "rootDirectory": "C:\\llama.cpp",
            "port": 8080,
            "activeModelId": active_model["id"],
            "conflict": None,
            "models": [
                {
                    **model,
                    "available": setup_ready["value"],
                    "missing": [] if setup_ready["value"] else ["model"],
                    "state": "running" if active_model["id"] == model["id"] else "stopped",
                    "ready": active_model["id"] == model["id"],
                    "pids": [4242] if active_model["id"] == model["id"] else [],
                    "files": {"model": f"C:\\llama.cpp\\models\\{model['modelFile']}"},
                }
                for model in models
            ],
        }

    def handle(route) -> None:
        request = route.request
        if request.url.endswith("/setup-prompt"):
            route.fulfill(
                json={
                    "prompt": "Set up Hacker's Lair Local Models at C:\\llama.cpp.\n"
                    "Use Vulkan and never run both models at once."
                }
            )
            return
        if request.method == "POST":
            body = request.post_data_json
            active_model["id"] = body["id"] if request.url.endswith("/start") else None
            route.fulfill(json={"ok": True, "id": body["id"]})
            return
        route.fulfill(json=payload())

    page.route("**/api/local-models", handle)
    page.route("**/api/local-models/**", handle)
    page.get_by_role("tab", name="Local Models", exact=True).click()
    page.evaluate("Promise.all([loadLocalModels(true), loadLocalInferencePrompt(true)])")
    panel = page.locator(".local-inference-deck")
    channels = panel.locator(".model-channel")
    expect(channels).to_have_count(2)
    coder = channels.filter(has_text="Qwen3 Coder Next")
    model_35b = channels.filter(has_text="Qwen3.6 35B A3B")
    expect(coder).to_contain_text("UD-Q3_K_XL · 28.22 gen tok/s")
    expect(model_35b).to_contain_text("UD-Q6_K · 26.54 gen tok/s")
    expect(panel.get_by_text("Set up this machine with your agent", exact=True)).to_be_visible()
    expect(panel.locator(".agent-prompt")).to_contain_text("Use Vulkan")
    panel.get_by_role("button", name="Copy agent prompt", exact=True).click()
    expect(panel.get_by_role("button", name="Copied", exact=True)).to_be_visible()
    page.set_viewport_size({"width": 900, "height": 620})
    assert not page.evaluate(
        "document.documentElement.scrollWidth > document.documentElement.clientWidth"
    ), "Local Models has horizontal overflow at 900x620."
    page.set_viewport_size({"width": 1440, "height": 900})
    setup_ready["value"] = True
    page.evaluate("loadLocalModels(true)")
    expect(panel.locator(".local-agent-handoff")).to_have_count(0)
    expect(panel.get_by_text("Setup complete", exact=False)).to_have_count(0)
    unused_space_below_deck = page.evaluate(
        """() => {
          const matrix = document.querySelector('.matrix').getBoundingClientRect();
          const deck = document.querySelector('.local-inference-deck').getBoundingClientRect();
          return matrix.bottom - deck.bottom;
        }"""
    )
    assert unused_space_below_deck <= 20, (
        f"Local Models reserves {unused_space_below_deck}px below its content."
    )

    page.get_by_role("button", name="Settings", exact=True).click()
    page.get_by_role("button", name=re.compile(r"Agent prompts")).click()
    prompt_dialog = page.get_by_role("dialog", name="Agent Prompts")
    expect(prompt_dialog).to_be_visible()
    model_prompt = prompt_dialog.locator('[data-prompt-library-id="local-models"]')
    expect(model_prompt).to_contain_text("Local Models setup")
    expect(model_prompt.locator("pre")).to_contain_text("Use Vulkan")
    OUTPUT_DIRECTORY.mkdir(exist_ok=True)
    page.screenshot(
        path=str(OUTPUT_DIRECTORY / "agent-prompts-1440x900.png"),
        full_page=False,
    )
    model_prompt.get_by_role("button", name="Copy prompt", exact=True).click()
    expect(model_prompt.get_by_role("button", name="Copied", exact=True)).to_be_visible()
    prompt_dialog.get_by_role("button", name="Close agent prompts").click()
    expect(prompt_dialog).to_be_hidden()

    coder_actions = coder.locator(".model-switch .action")
    expect(coder_actions).to_have_count(1)
    expect(coder_actions).to_have_class(re.compile(r"\binitiate\b"))
    expect(coder.get_by_role("button", name="On", exact=True)).to_be_enabled()
    expect(coder.get_by_role("button", name="Off", exact=True)).to_have_count(0)

    coder.get_by_role("button", name="On", exact=True).click()
    expect(coder.locator(".model-state")).to_have_text("ONLINE")
    expect(model_35b.get_by_role("button", name="On", exact=True)).to_be_disabled()
    expect(coder.get_by_role("button", name="On", exact=True)).to_have_count(0)
    expect(coder_actions).to_have_count(1)
    expect(coder_actions).to_have_class(re.compile(r"\bterminate\b"))
    expect(coder.get_by_role("button", name="Off", exact=True)).to_be_enabled()
    OUTPUT_DIRECTORY.mkdir(exist_ok=True)
    page.screenshot(
        path=str(OUTPUT_DIRECTORY / "local-model-controls-1440x900.png"),
        full_page=False,
    )

    coder.get_by_role("button", name="Off", exact=True).click()
    expect(coder.locator(".model-state")).to_have_text("OFFLINE")
    expect(coder.get_by_role("button", name="Off", exact=True)).to_have_count(0)
    expect(coder_actions).to_have_class(re.compile(r"\binitiate\b"))
    expect(model_35b.get_by_role("button", name="On", exact=True)).to_be_enabled()
    page.get_by_role("tab", name="Targets", exact=True).click()
    page.unroute("**/api/local-models", handle)
    page.unroute("**/api/local-models/**", handle)
    page.evaluate("loadLocalModels(true)")


def assert_port_signal_action_tray(page, live_port: int) -> None:
    page.get_by_role("tab", name="Port Signals", exact=True).click()
    signal = page.locator('[data-card-kind="process"]').filter(
        has_text=f":{live_port}"
    )
    expect(signal).to_be_visible(timeout=15_000)
    actions = signal.locator(".action-cluster .action")
    expect(actions).to_have_count(1)
    expect(actions).to_have_text("TERMINATE")
    tray_box = signal.locator(".action-cluster").bounding_box()
    action_box = actions.bounding_box()
    assert tray_box is not None and action_box is not None
    assert tray_box["width"] <= action_box["width"] + 20
    page.get_by_role("tab", name="Targets", exact=True).click()


def assert_script_action_tray(page, script_name: str) -> None:
    page.get_by_role("tab", name="Scripts", exact=True).click()
    add_script = page.locator("#addScript")
    expect(add_script).to_be_visible()
    add_script.click()
    dialog = page.get_by_role("dialog", name="Add Script")
    expect(dialog).to_be_visible()
    expect(dialog).to_contain_text("Agent-assisted")
    expect(dialog).to_contain_text("Recommended")
    expect(dialog).to_contain_text("Manual setup")
    expect(dialog.locator("#additionalScriptPrompt")).to_contain_text(script_name)
    dialog.locator("#copyAdditionalScriptPrompt").click()
    expect(dialog.locator("#copyAdditionalScriptPrompt")).to_have_text("Copied")
    dialog.get_by_role("button", name="Close", exact=True).first.click()
    expect(dialog).to_be_hidden()

    script = page.locator('[data-card-kind="script"]').filter(
        has_text=script_name.removesuffix(".au3")
    )
    expect(script).to_be_visible(timeout=15_000)
    actions = script.locator(".action-cluster .action")
    expect(actions).to_have_count(1)
    expect(actions).to_have_text("INITIATE")
    expect(actions).to_be_visible()
    tray_box = script.locator(".action-cluster").bounding_box()
    action_box = actions.bounding_box()
    assert tray_box is not None and action_box is not None
    assert tray_box["width"] <= action_box["width"] + 20
    page.get_by_role("tab", name="Targets", exact=True).click()


def assert_minimal_update_controls(page) -> None:
    expect(page.locator("#updateBanner")).to_have_count(0)
    update_trigger = page.locator("#updateAvailableTrigger")
    expect(update_trigger).to_be_hidden()
    release_notes = page.get_by_role("button", name="Release notes")
    expect(release_notes).to_be_hidden()

    page.evaluate("window.__lairUpdateListener(window.__availableUpdate)")
    expect(update_trigger).to_be_visible()
    expect(update_trigger).to_contain_text("v2.1.0-beta.3")
    update_trigger.click()

    dialog = page.get_by_role("dialog", name="Update available")
    expect(dialog).to_be_visible()
    expect(dialog).to_contain_text(
        "v2.1.0-beta.3 is available."
    )
    expect(dialog.locator("#updateCommand")).to_have_text(
        "irm https://hackerslairhq.github.io/desktop/install.ps1 | iex"
    )
    expect(dialog.locator("#releaseNotesBody")).to_have_count(0)
    expect(dialog.locator("#updateCurrentVersion")).to_have_count(0)
    expect(dialog.locator("#updateChannel")).to_have_count(0)
    expect(dialog.locator("#updateStatus")).to_have_count(0)
    dialog.get_by_role("button", name="Copy command").click()
    expect(page.locator("#toast")).to_have_text("Update command copied.")
    dialog.get_by_role("button", name="Close", exact=True).click()
    expect(dialog).to_be_hidden()

    page.set_viewport_size({"width": 900, "height": 620})
    update_trigger.click()
    dialog_box = dialog.bounding_box()
    assert dialog_box is not None
    assert dialog_box["x"] >= 0 and dialog_box["y"] >= 0
    assert dialog_box["x"] + dialog_box["width"] <= 900
    assert dialog_box["y"] + dialog_box["height"] <= 620
    page.keyboard.press("Escape")
    expect(dialog).to_be_hidden()
    page.set_viewport_size({"width": 1440, "height": 900})


def assert_settings_panel(page, scripts_supported: bool) -> None:
    settings = page.get_by_role("button", name="Settings", exact=True)
    expect(settings).to_be_visible()
    settings.click()

    popover = page.locator("#settingsPopover")
    expect(popover).to_be_visible()
    for theme in ["phosphor", "ultraviolet", "ice", "volt", "ghost"]:
        page.locator("html").evaluate("(root, value) => { root.dataset.theme = value; }", theme)
        option_style = page.locator("#themePreference option").first.evaluate(
            """option => {
                const style = getComputedStyle(option);
                const luminance = color => {
                    const channels = color.match(/[\\d.]+/g).slice(0, 3).map(value => {
                        const normalized = Number(value) / 255;
                        return normalized <= 0.04045
                            ? normalized / 12.92
                            : ((normalized + 0.055) / 1.055) ** 2.4;
                    });
                    return (0.2126 * channels[0]) + (0.7152 * channels[1]) + (0.0722 * channels[2]);
                };
                const foreground = luminance(style.color);
                const background = luminance(style.backgroundColor);
                const contrastRatio = (Math.max(foreground, background) + 0.05)
                    / (Math.min(foreground, background) + 0.05);
                const rootStyle = getComputedStyle(document.documentElement);
                const surface = rootStyle.getPropertyValue('--panel-solid').trim();
                const resolveColor = value => {
                    const probe = document.createElement('span');
                    probe.style.color = value;
                    document.body.append(probe);
                    const resolved = getComputedStyle(probe).color;
                    probe.remove();
                    return resolved;
                };
                const surfaceLuminance = luminance(resolveColor(surface));
                const tokenContrastRatios = Object.fromEntries(
                    ['--text', '--muted', '--dim', '--green', '--cyan', '--amber', '--red']
                        .map(token => {
                            const tokenLuminance = luminance(resolveColor(
                                rootStyle.getPropertyValue(token).trim()
                            ));
                            const ratio = (Math.max(tokenLuminance, surfaceLuminance) + 0.05)
                                / (Math.min(tokenLuminance, surfaceLuminance) + 0.05);
                            return [token, ratio];
                        })
                );
                return {
                    color: style.color,
                    backgroundColor: style.backgroundColor,
                    contrastRatio,
                    tokenContrastRatios,
                };
            }"""
        )
        assert option_style["backgroundColor"] not in {
            "transparent",
            "rgba(0, 0, 0, 0)",
        }, f"{theme} option background is transparent: {option_style}"
        assert (
            option_style["color"] != option_style["backgroundColor"]
        ), f"{theme} option text matches its background: {option_style}"
        assert (
            option_style["contrastRatio"] >= 4.5
        ), f"{theme} option contrast is below WCAG AA: {option_style}"
        if theme in {"ultraviolet", "volt"}:
            assert all(
                ratio >= 4.5
                for ratio in option_style["tokenContrastRatios"].values()
            ), f"{theme} has a token below WCAG AA: {option_style}"
    page.locator("html").evaluate("(root) => { root.dataset.theme = 'phosphor'; }")
    expect(page.locator("#themePreference")).to_have_value("phosphor")
    page.locator("#themePreference").select_option("ice")
    expect(page.locator("html")).to_have_attribute("data-theme", "ice")
    expect(page.locator("#densityPreference")).to_have_value("comfortable")
    page.locator("#densityPreference").select_option("compact")
    expect(page.locator("html")).to_have_attribute("data-density", "compact")
    page.locator("#motionPreference").select_option("reduced")
    expect(page.locator("html")).to_have_attribute("data-motion", "reduced")
    page.locator("#fontScalePreference").select_option("110")
    expect(page.locator("html")).to_have_attribute("style", re.compile(r"--font-scale:\s*110%"))
    expect(page.locator("#settingsSync")).to_have_text("Saved")

    skills = page.get_by_role("switch", name=re.compile(r"AI Workflow"))
    scripts = page.get_by_role("switch", name=re.compile(r"Scripts panel"))
    expect(skills).to_be_checked()
    expect(page.locator("#skillsTab")).to_be_visible()
    expect(page.locator("#scriptsTab")).to_be_hidden()

    skills.uncheck()
    expect(page.locator("#skillsTab")).to_be_hidden()
    skills.check()
    expect(page.locator("#skillsTab")).to_be_visible()
    expect(page.locator("#settingsPopover")).not_to_contain_text("Usage stats")
    expect(page.locator("#settingsPopover")).not_to_contain_text("Cold after")
    expect(page.locator("#settingsPopover")).not_to_contain_text("Session feed")
    expect(page.locator("#settingsPopover")).not_to_contain_text("Tax warning")

    if scripts_supported:
        expect(scripts).to_be_visible()
        expect(scripts).not_to_be_checked()
        scripts.check()
        expect(scripts).to_be_checked()
        expect(page.locator("#scriptsTab")).to_be_visible()
    else:
        expect(page.locator("#scriptsPanelField")).to_be_hidden()

    launch = page.get_by_role("switch", name=re.compile(r"Launch on startup"))
    expect(launch).not_to_be_checked()
    expect(page.locator("#launchOnStartupStatus")).to_have_text("Disabled")

    launch.check()
    expect(launch).to_be_checked()
    expect(page.locator("#launchOnStartupStatus")).to_have_text("Enabled")
    assert page.evaluate("window.__launchOnStartup") is True

    launch.uncheck()
    expect(launch).not_to_be_checked()
    expect(page.locator("#launchOnStartupStatus")).to_have_text("Disabled")
    assert page.evaluate("window.__launchOnStartup") is False

    release_notes = page.get_by_role("button", name="Release notes")
    expect(release_notes).to_be_visible()
    release_notes.click()
    assert page.evaluate("window.__releaseNotesOpened") is True
    expect(popover).to_be_hidden()
    settings.click()
    expect(popover).to_be_visible()

    page.set_viewport_size({"width": 900, "height": 620})
    popover_box = popover.bounding_box()
    assert popover_box is not None
    assert popover_box["x"] >= 0 and popover_box["y"] >= 0
    assert popover_box["x"] + popover_box["width"] <= 900
    assert popover_box["y"] + popover_box["height"] <= 620

    page.keyboard.press("Escape")
    expect(popover).to_be_hidden()
    page.set_viewport_size({"width": 1440, "height": 900})


def assert_skills_maintenance(page) -> None:
    page.get_by_role("tab", name="Skills", exact=True).click()
    expect(page.get_by_role("button", name="Copy fallback instruction")).to_be_visible()
    page.set_viewport_size({"width": 900, "height": 620})
    has_overflow = page.evaluate(
        "() => document.documentElement.scrollWidth > document.documentElement.clientWidth"
    )
    assert not has_overflow, "Skills maintenance has horizontal overflow at 900x620."
    page.set_viewport_size({"width": 1440, "height": 900})
    verify = page.locator('[data-card-kind="skill"]').filter(has_text="verify")
    expect(verify).to_be_visible(timeout=15_000)
    expect(verify).to_contain_text("1 use")
    expect(verify.locator(".skill-health")).to_have_class(re.compile(r"\bok\b"))
    expect(verify.get_by_role("button", name=re.compile(r"Mark verify effective"))).to_have_text("+ 0")
    verify.get_by_role("button", name=re.compile(r"Mark verify effective")).click()
    expect(verify.get_by_role("button", name=re.compile(r"Mark verify effective"))).to_have_text("+ 1")

    context_trigger = page.locator("#contextTaxTrigger")
    expect(context_trigger).to_contain_text("Context")
    context_trigger.click()
    context_dialog = page.get_by_role("dialog", name="Context Tax")
    expect(context_dialog).to_be_visible()
    expect(context_dialog.locator("#contextCostSummary")).to_contain_text("Estimated")
    context_dialog.get_by_role("button", name="Close", exact=True).first.click()

    page.locator("#newSkill").click()
    new_skill = page.get_by_role("dialog", name="New Skill")
    expect(new_skill).to_be_visible()
    expect(new_skill).to_contain_text("Agent-assisted")
    expect(new_skill).to_contain_text("Recommended")
    expect(new_skill).to_contain_text("Manual scaffold")
    expect(new_skill.locator("#additionalSkillPrompt")).to_contain_text(
        "Personal skills directory"
    )
    page.set_viewport_size({"width": 900, "height": 620})
    skill_dialog_box = new_skill.bounding_box()
    assert skill_dialog_box is not None
    assert skill_dialog_box["x"] >= 0 and skill_dialog_box["y"] >= 0
    assert skill_dialog_box["x"] + skill_dialog_box["width"] <= 900
    assert skill_dialog_box["y"] + skill_dialog_box["height"] <= 620
    page.set_viewport_size({"width": 1440, "height": 900})
    new_skill.locator("#copyAdditionalSkillPrompt").click()
    expect(new_skill.locator("#copyAdditionalSkillPrompt")).to_have_text("Copied")
    new_skill.locator("#newSkillName").fill("browser-helper")
    new_skill.get_by_role("button", name="Create Skill").click()
    expect(new_skill).to_be_hidden()

    helper = page.locator('[data-card-kind="skill"]').filter(has_text="browser-helper")
    expect(helper).to_be_visible()
    helper.get_by_role("button", name="Archive").click()
    archive = page.get_by_role("dialog", name="Archive Skill")
    expect(archive).to_be_visible()
    expect(archive).to_contain_text("timestamped backup")
    archive.get_by_role("button", name="Archive", exact=True).click()
    expect(archive).to_be_hidden()
    expect(helper).to_have_count(0)

    archived = page.locator(".archived-skills")
    expect(archived).to_be_visible()
    archived.locator("summary").click()
    archived.get_by_role("button", name="Restore").click()
    expect(page.locator('[data-card-kind="skill"]').filter(has_text="browser-helper")).to_be_visible()
    page.get_by_role("tab", name="Targets", exact=True).click()


def assert_maintenance_loop(page) -> None:
    with page.expect_response(
        lambda response: response.url.endswith("/api/skills") and response.status == 200
    ):
        page.get_by_role("tab", name="Skills", exact=True).click()
    expect(page.locator("#targetList")).to_have_attribute("aria-busy", "false")
    route_input = page.locator("[data-skill-route-input]")
    route_input.fill("verify repository changes before release")
    route_results = page.locator("[data-skill-route-results]")
    expect(route_results).to_contain_text("verify")

    friction_input = page.locator("#frictionInput")
    for text in [
        "Agent skipped repository verification on run 1",
        "Agent skipped repository verification on run 2",
        "Agent skipped repository verification on run 3",
    ]:
        friction_input.fill(text)
        page.locator("#logFriction").click()
        expect(friction_input).to_have_value("")

    page.get_by_role("tab", name="Instructions", exact=True).click()
    expect(page.locator(".friction-panel")).to_contain_text("skipped-repository-verification-run")
    expect(page.locator(".friction-panel")).to_contain_text("3")
    create_skill = page.locator("[data-friction-scaffold]")
    expect(create_skill).to_be_visible()
    create_skill.click()
    new_skill = page.get_by_role("dialog", name="New Skill")
    expect(new_skill.locator("#newSkillName")).not_to_have_value("")
    new_skill.get_by_role("button", name="Cancel").click()

    instruction = page.locator('[data-card-kind="instruction"]').filter(has_text="AGENTS.md")
    expect(instruction).to_be_visible()
    with page.expect_response(
        lambda response: response.url.endswith("/api/ai/instructions/drift")
        and response.status == 200
    ):
        instruction.get_by_role("button", name="Check drift").click()
    expect(instruction).to_contain_text("Command is not available on PATH")
    expect(instruction).to_contain_text("Referenced path does not exist")
    page.get_by_role("tab", name="Targets", exact=True).click()


def visible_tab_positions(page) -> list[dict]:
    return page.locator(".view-tab:not([hidden])").evaluate_all(
        """elements => elements.map((element) => {
            const box = element.getBoundingClientRect();
            return { text: element.textContent.trim(), x: box.x, y: box.y };
        })"""
    )


def agent_ops_nav_geometry(page) -> dict:
    return page.locator(".agent-ops-nav").evaluate(
        """element => {
            const box = element.getBoundingClientRect();
            const scrolling = document.scrollingElement;
            return {
                box: { x: box.x, y: box.y, width: box.width, height: box.height },
                scrollTop: scrolling.scrollTop,
                scrollHeight: scrolling.scrollHeight,
                clientHeight: scrolling.clientHeight,
                clientWidth: scrolling.clientWidth,
            };
        }"""
    )


def assert_agent_ops_nav_stable(page, expected: dict) -> None:
    actual = agent_ops_nav_geometry(page)
    assert actual["box"] == expected["box"], (
        f"Agent Ops navigation moved: expected={expected}, actual={actual}"
    )


def assert_agent_ops(page) -> None:
    page.evaluate("() => document.fonts.ready")
    tab_positions = visible_tab_positions(page)
    page.get_by_role("tab", name="Agent Ops", exact=True).click()
    expect(page.locator("#targetList")).to_have_attribute("aria-busy", "false")
    expect(page.locator(".filter-row .agent-ops-nav")).to_be_visible()
    assert visible_tab_positions(page) == tab_positions
    nav_geometry = agent_ops_nav_geometry(page)
    subagent = page.locator('[data-card-kind="agent-op"]').filter(has_text="reviewer")
    expect(subagent).to_be_visible()
    expect(subagent).to_contain_text("1 use")
    page.locator("#nodeName").evaluate("(node) => { node.textContent = 'LOCALHOST'; }")
    OUTPUT_DIRECTORY.mkdir(exist_ok=True)
    page.screenshot(
        path=str(OUTPUT_DIRECTORY / "agent-ops-1440x900.png"),
        full_page=False,
    )

    page.get_by_role("button", name="Commands", exact=True).click()
    assert_agent_ops_nav_stable(page, nav_geometry)
    expect(page.locator('[data-card-kind="agent-op"]').filter(has_text="release/check")).to_be_visible()
    page.get_by_role("button", name="MCP", exact=True).click()
    assert_agent_ops_nav_stable(page, nav_geometry)
    expect(page.locator('[data-card-kind="agent-op"]').filter(has_text="fixtureDocs")).to_be_visible()
    page.get_by_role("button", name="Permissions", exact=True).click()
    assert_agent_ops_nav_stable(page, nav_geometry)
    expect(page.locator('[data-card-kind="agent-op"]').filter(has_text="Read")).to_be_visible()
    page.get_by_role("button", name="Hooks", exact=True).click()
    assert_agent_ops_nav_stable(page, nav_geometry)
    expect(page.locator('[data-card-kind="agent-op"]').filter(has_text="Bash")).to_be_visible()
    expect(page.get_by_role("button", name="Sessions", exact=True)).to_have_count(0)
    page.get_by_role("button", name="Memory", exact=True).click()
    assert_agent_ops_nav_stable(page, nav_geometry)
    expect(page.locator('[data-card-kind="agent-op"]').filter(has_text="decisions.md")).to_be_visible()
    page.get_by_role("button", name="Coverage", exact=True).click()
    assert_agent_ops_nav_stable(page, nav_geometry)
    expect(page.locator('[data-card-kind="agent-op"]').filter(has_text="Live Fixture")).to_be_visible()
    page.get_by_role("button", name="Parity", exact=True).click()
    assert_agent_ops_nav_stable(page, nav_geometry)
    expect(
        page.locator('[data-card-kind="agent-op"]').filter(has_text="verify").first
    ).to_be_visible()
    page.get_by_role("tab", name="Targets", exact=True).click()


def assert_palette_and_theme(page) -> None:
    page.keyboard.press("Control+K")
    palette = page.locator("#commandPalette")
    expect(palette).to_be_visible()
    results = palette.locator(".command-result")
    expect(results.filter(has_text="STOP").filter(has_text="Live Fixture")).to_have_count(1)
    expect(results.filter(has_text="START").filter(has_text="Live Fixture")).to_have_count(0)
    expect(results.filter(has_text="START").filter(has_text="Dormant Fixture")).to_have_count(1)
    expect(results.filter(has_text="STOP").filter(has_text="Dormant Fixture")).to_have_count(0)

    page.locator("#commandInput").fill("ultraviolet")
    ultraviolet = results.filter(has_text="THEME").filter(has_text="ultraviolet")
    expect(ultraviolet).to_have_count(1)
    ultraviolet.click()
    expect(page.locator("html")).to_have_attribute("data-theme", "ultraviolet")
    page.reload(wait_until="networkidle")
    expect(page.locator("html")).to_have_attribute("data-theme", "ultraviolet")


def capture_theme_previews(page) -> None:
    OUTPUT_DIRECTORY.mkdir(exist_ok=True)
    page.locator("body").evaluate(
        """body => {
            const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
            while (walker.nextNode()) {
                walker.currentNode.nodeValue = walker.currentNode.nodeValue
                    .replace(/[A-Z]:\\\\Users\\\\[^\\\\\\s]+/gi, '%USERPROFILE%')
                    .replace(/[A-Z]:\\\\[^\\r\\n;]+/gi, '<LOCAL_PATH>');
            }
            const host = document.querySelector('#nodeName');
            if (host) host.textContent = 'LOCALHOST';
        }"""
    )
    page.locator(".compact-path").evaluate_all(
        """paths => paths.forEach((path, index) => {
            path.textContent = index ? 'C:\\\\Dev\\\\sample-api' : 'C:\\\\Dev\\\\sample-web';
            path.title = path.textContent;
        })"""
    )
    for theme in ["ultraviolet", "volt"]:
        page.locator("html").evaluate("(root, value) => { root.dataset.theme = value; }", theme)
        for width, height in [(1440, 900), (900, 620)]:
            page.set_viewport_size({"width": width, "height": height})
            page.wait_for_timeout(150)
            page.screenshot(
                path=str(OUTPUT_DIRECTORY / f"theme-{theme}-{width}x{height}.png"),
                full_page=False,
            )
            has_overflow = page.evaluate(
                "() => document.documentElement.scrollWidth > document.documentElement.clientWidth"
            )
            assert not has_overflow, f"{theme} has horizontal overflow at {width}x{height}."
    page.set_viewport_size({"width": 1440, "height": 900})


def assert_responsive_layout(page) -> None:
    page.set_viewport_size({"width": 900, "height": 620})
    page.wait_for_timeout(250)
    target_tab_positions = visible_tab_positions(page)
    page.get_by_role("tab", name="Skills", exact=True).click()
    skill_tab_positions = visible_tab_positions(page)
    assert skill_tab_positions == target_tab_positions, (
        f"View tabs moved at 900x620: targets={target_tab_positions}, "
        f"skills={skill_tab_positions}"
    )
    page.get_by_role("tab", name="Agent Ops", exact=True).click()
    agent_ops_tab_positions = visible_tab_positions(page)
    assert agent_ops_tab_positions == target_tab_positions, (
        f"View tabs moved at 900x620: targets={target_tab_positions}, "
        f"agentOps={agent_ops_tab_positions}"
    )
    expect(page.locator(".filter-row .agent-ops-nav")).to_be_visible()
    expect(
        page.locator('[data-card-kind="agent-op"]').filter(has_text="reviewer")
    ).to_be_visible()
    OUTPUT_DIRECTORY.mkdir(exist_ok=True)
    page.screenshot(
        path=str(OUTPUT_DIRECTORY / "agent-ops-900x620.png"),
        full_page=False,
    )
    has_overflow = page.evaluate(
        "() => document.documentElement.scrollWidth > document.documentElement.clientWidth"
    )
    assert not has_overflow, "The minimum window viewport has horizontal overflow."


def assert_compact_desktop_layout(page) -> None:
    page.set_viewport_size({"width": 1240, "height": 800})
    page.wait_for_timeout(250)
    matrix_box = page.locator(".matrix").bounding_box()
    side_box = page.locator(".side-rack").bounding_box()
    assert matrix_box is not None and side_box is not None
    assert side_box["x"] == matrix_box["x"], (
        "The compact desktop sidebar should stack below the control deck: "
        f"matrix={matrix_box}, side={side_box}"
    )
    assert side_box["y"] > matrix_box["y"] + matrix_box["height"]
    has_overflow = page.evaluate(
        "() => document.documentElement.scrollWidth > document.documentElement.clientWidth"
    )
    assert not has_overflow, "The compact desktop viewport has horizontal overflow."
    page.set_viewport_size({"width": 1440, "height": 900})


def run() -> None:
    data_directory = Path(tempfile.mkdtemp(prefix="hackers-lair-playwright-"))
    manager_port = free_port()
    identity_file = data_directory / "api-token"
    live_directory = data_directory / "live-fixture"
    dormant_directory = data_directory / "dormant-fixture"
    live_directory.mkdir()
    dormant_directory.mkdir()
    write_projects(data_directory, [])
    script_name = None
    agents_home = data_directory / "agents"
    agents_home.mkdir()
    verify_skill = agents_home / "skills" / "verify"
    (agents_home / "usage-log.jsonl").write_text(
        "\n".join(
            json.dumps(event)
            for event in [
                {
                "type": "skill",
                "name": "verify",
                "project": str(data_directory),
                "ts": "2026-07-27T18:04:11.000Z",
                "source": "manual",
                },
                {
                    "type": "agent",
                    "name": "reviewer",
                    "project": str(data_directory),
                    "ts": "2026-07-27T18:04:11.000Z",
                    "source": "manual",
                },
                {
                    "type": "command",
                    "name": "release/check",
                    "project": str(data_directory),
                    "ts": "2026-07-27T18:04:11.000Z",
                    "source": "manual",
                },
            ]
        )
        + "\n",
        encoding="utf-8",
    )
    claude_home = data_directory / "claude"
    claude_home.mkdir()
    (claude_home / "agents").mkdir()
    (claude_home / "commands" / "release").mkdir(parents=True)
    (claude_home / "agents" / "reviewer.md").write_text(
        "---\n"
        "name: reviewer\n"
        "description: Review repository changes for correctness and security.\n"
        "tools: Read, Grep\n"
        "model: inherit\n"
        "---\n",
        encoding="utf-8",
    )
    (claude_home / "commands" / "release" / "check.md").write_text(
        "---\n"
        "description: Check whether a release is ready for publication.\n"
        "---\n",
        encoding="utf-8",
    )
    memory_directory = live_directory / ".claude" / "memory"
    memory_directory.mkdir(parents=True)
    (memory_directory / "decisions.md").write_text("# Fixture decisions\n", encoding="utf-8")
    (claude_home / "settings.json").write_text(
        json.dumps(
            {
                "permissions": {"allow": ["Read"]},
                "mcpServers": {"fixtureDocs": {"command": "node"}},
                "hooks": {
                    "PreToolUse": [
                        {
                            "matcher": "Bash",
                            "hooks": [{"type": "command", "command": "node fixture-check.js"}],
                        }
                    ]
                },
            }
        ),
        encoding="utf-8",
    )
    (data_directory / "AGENTS.md").write_text(
        "# Fixture instructions\n\n"
        "Run `missing-lair-tool --verify` and inspect `scripts/missing.js`.\n",
        encoding="utf-8",
    )

    environment = {
        **os.environ,
        "PORT": str(manager_port),
        "PROJECT_MANAGER_DATA_DIR": str(data_directory),
        "AGENTS_HOME": str(agents_home),
        "CLAUDE_CONFIG_DIR": str(claude_home),
        "LAIR_WORKSPACE_ROOT": str(data_directory),
        "LLAMA_CPP_ROOT": str(data_directory / "missing-llama-root"),
    }
    service = subprocess.Popen(
        ["node", str(ROOT / "server.js")],
        cwd=ROOT,
        env=environment,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    identity: dict | None = None
    browser = None
    console_errors: list[str] = []
    try:
        identity = wait_for_identity(identity_file, service)
        origin = f"http://127.0.0.1:{identity['port']}/"
        with ListeningFixture() as live_listener, sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            page = browser.new_page(viewport={"width": 1440, "height": 900})
            page.context.grant_permissions(
                ["clipboard-read", "clipboard-write"],
                origin=origin.rstrip("/"),
            )
            page.on(
                "console",
                lambda message: console_errors.append(message.text)
                if message.type == "error"
                else None,
            )
            page.on("pageerror", lambda error: console_errors.append(str(error)))
            page.add_init_script(
                """
                localStorage.setItem('hackersLair.cinematicSeen', '1');
                window.__availableUpdate = {
                  channel: 'powershell',
                  channelLabel: 'PowerShell portable',
                  currentVersion: '2.1.0-beta.2',
                  mode: 'manual',
                  status: 'available',
                  version: '2.1.0-beta.3',
                  message: 'v2.1.0-beta.3 is available. Update when convenient with the PowerShell portable install command.',
                  upgradeCommand: 'irm https://hackerslairhq.github.io/desktop/install.ps1 | iex',
                  releaseUrl: 'https://github.com/hackerslairhq/desktop/releases/tag/v2.1.0-beta.3',
                  releaseNotes: '### Fixed\\n\\n- Portable update fixture notes.',
                  managedTargets: [],
                };
                window.hackerLairWindow = {
                  minimize: () => {},
                  toggleMaximize: () => {},
                  close: () => {},
                  restart: () => {},
                  shutdown: () => {},
                  onMaximizeChange: () => () => {},
                  getLaunchAtLogin: async () => ({
                    supported: true,
                    enabled: Boolean(window.__launchOnStartup),
                  }),
                  setLaunchAtLogin: async (enabled) => {
                    window.__launchOnStartup = Boolean(enabled);
                    return { supported: true, enabled: window.__launchOnStartup };
                  },
                  getUpdateState: async () => ({
                    channel: 'powershell',
                    channelLabel: 'PowerShell portable',
                    currentVersion: '2.1.0-beta.2',
                    mode: 'manual',
                    status: 'manual',
                    version: '',
                    message: 'Updates use the PowerShell portable install channel.',
                    upgradeCommand: 'irm https://hackerslairhq.github.io/desktop/install.ps1 | iex',
                    releaseUrl: 'https://github.com/hackerslairhq/desktop/releases',
                    releaseNotes: '### Fixed\\n\\n- Current release fixture notes.',
                    managedTargets: [],
                  }),
                  onUpdateState: (callback) => {
                    window.__lairUpdateListener = callback;
                    return () => {};
                  },
                  openUpdateNotes: async () => {
                    window.__releaseNotesOpened = true;
                    return true;
                  },
                };
                """
            )
            page.goto(origin, wait_until="domcontentloaded")
            assert_first_run_setup(page)
            verify_skill.mkdir(parents=True)
            (verify_skill / "SKILL.md").write_text(
                "---\n"
                "name: verify\n"
                "description: Verify repository changes through public interfaces before release.\n"
                "---\n\n"
                "# Verify\n",
                encoding="utf-8",
            )
            script_name = write_script_fixture(data_directory) if os.name == "nt" else None
            page.reload(wait_until="networkidle")
            expect(page.get_by_role("dialog", name="Commission Your Lair")).to_be_hidden()
            assert_full_motion_canvas_settles(page)
            assert_empty_state(page)
            assert_project_editor_controls(page, data_directory / "chosen-folder")
            assert_project_port_conflict(
                page,
                live_directory,
                live_listener.port,
                console_errors,
            )

            dormant_port = free_port()
            write_projects(
                data_directory,
                [
                    project_fixture(
                        name="Live Fixture",
                        directory=live_directory,
                        port=live_listener.port,
                        component_name="live-web",
                    ),
                    project_fixture(
                        name="Dormant Fixture",
                        directory=dormant_directory,
                        port=dormant_port,
                        component_name="dormant-web",
                    ),
                ],
            )
            assert_target_states(page, live_listener.port, dormant_port)
            assert_local_model_controls(page)
            assert_compact_desktop_layout(page)
            assert_port_signal_action_tray(page, live_listener.port)
            assert_minimal_update_controls(page)
            assert_settings_panel(page, scripts_supported=script_name is not None)
            assert_skills_maintenance(page)
            assert_maintenance_loop(page)
            assert_agent_ops(page)
            if script_name:
                assert_script_action_tray(page, script_name)
            assert_palette_and_theme(page)
            capture_theme_previews(page)
            assert_responsive_layout(page)
            assert not console_errors, f"Browser console errors: {console_errors}"
            browser.close()
            browser = None
        print(
            "Playwright UI smoke passed: empty state, port conflict warning, target states, "
            "compact action trays, panel/startup settings, minimal update controls, "
            "Skills maintenance, every Agent Ops inventory, stable view controls, palette, "
            "theme, and 900x620."
        )
    except Exception:
        OUTPUT_DIRECTORY.mkdir(exist_ok=True)
        try:
            if browser is not None:
                pages = browser.contexts[0].pages if browser.contexts else []
                if pages:
                    pages[0].screenshot(
                        path=str(OUTPUT_DIRECTORY / "playwright-ui-failure.png"),
                        full_page=True,
                    )
        except PlaywrightError:
            pass
        raise
    finally:
        if browser is not None:
            try:
                browser.close()
            except PlaywrightError:
                pass
        if identity is not None and service.poll() is None:
            try:
                shutdown_service(identity)
                service.wait(timeout=5)
            except (OSError, subprocess.TimeoutExpired):
                service.kill()
        elif service.poll() is None:
            service.kill()
        shutil.rmtree(data_directory, ignore_errors=True)


if __name__ == "__main__":
    run()
