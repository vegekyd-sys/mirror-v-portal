#!/usr/bin/env python3
"""
heartbeat.py — Platform-agnostic maintenance scheduler for Knight OS.

Executes periodic maintenance tasks:
  1. Reflection analysis — detect repeated failure patterns
  2. Memory scan — check MEMORY.md staleness
  3. Log compression — check logs directory size
  4. Wiki maintenance — link wiki pages and create promotion proposals
  5. Project queue scan — scan project TODOs for ready tasks
  6. Token budget check — verify GPT-5.5 weekly usage against thresholds
  7. Makaron marketing image — generate next cover image

Usage:
  python3 scripts/heartbeat.py
"""

import json
import os
import re
import sys
import subprocess
import hashlib
from datetime import datetime, timezone
from pathlib import Path
from collections import Counter


def load_config():
    config_paths = [
        Path.cwd() / "knight.config.json",
        Path.home() / ".knight" / "config.json",
    ]
    for p in config_paths:
        if p.exists():
            try:
                return json.loads(p.read_text())
            except (json.JSONDecodeError, OSError):
                pass
    return {}


def resolve_workspace(config):
    """Resolve the agent workspace root.

    Priority:
      1. explicit `workspace` in knight.config.json
      2. self-locating default: parent of this script's `scripts/` directory
    Never falls back to a shared global path, so runtime and packed payload stay isolated.
    """
    ws = config.get("workspace")
    if ws:
        return Path(ws).expanduser()
    return Path(__file__).resolve().parent.parent


def log(msg: str):
    ts = datetime.now().strftime("%H:%M:%S")
    print(f"[{ts}] {msg}", flush=True)


def format_bytes(num_bytes: int) -> str:
    """Human-readable byte count for heartbeat reports."""
    value = float(num_bytes)
    for unit in ("B", "KB", "MB", "GB"):
        if value < 1024 or unit == "GB":
            return f"{value:.1f} {unit}" if unit != "B" else f"{int(value)} B"
        value /= 1024


class MemoryUsageTracker:
    """Track memory artifacts read/scanned/written by one heartbeat cycle.

    This intentionally tracks Knight/OpenClaw memory artifacts (MEMORY.md and
    files under memory/), not OS RAM. It gives heartbeat a compact, auditable
    "Memory used this cycle" section aligned with memory-optimization retrieval
    rules: trigger, files/searches, behavioral effect, and follow-up.
    """

    def __init__(self, workspace: Path):
        self.workspace = workspace.expanduser().resolve()
        self.events: list[dict] = []

    def _relative(self, path: Path) -> str:
        try:
            return str(path.expanduser().resolve().relative_to(self.workspace))
        except (OSError, ValueError):
            return str(path)

    def _is_memory_path(self, path: Path) -> bool:
        rel = self._relative(path)
        return rel == "MEMORY.md" or rel.startswith("memory/")

    def record_path(
        self,
        kind: str,
        path: Path,
        *,
        trigger: str,
        effect: str,
        follow_up: str = "none",
        bytes_size: int | None = None,
        lines: int | None = None,
    ):
        """Record one memory file touch if it is inside the memory corpus."""
        path = Path(path)
        if not self._is_memory_path(path):
            return
        if bytes_size is None:
            try:
                bytes_size = path.stat().st_size
            except OSError:
                bytes_size = 0
        self.events.append(
            {
                "kind": kind,
                "path": self._relative(path),
                "trigger": trigger,
                "effect": effect,
                "follow_up": follow_up,
                "bytes": int(bytes_size or 0),
                "lines": lines,
            }
        )

    def record_external(self, name: str, *, trigger: str, effect: str, follow_up: str = "none"):
        """Record a delegated script whose internal memory touches are opaque."""
        self.events.append(
            {
                "kind": "delegated",
                "path": name,
                "trigger": trigger,
                "effect": effect,
                "follow_up": follow_up,
                "bytes": 0,
                "lines": None,
            }
        )

    def read_text(self, path: Path, *, trigger: str, effect: str, follow_up: str = "none") -> str:
        content = Path(path).read_text(encoding="utf-8")
        self.record_path(
            "read",
            Path(path),
            trigger=trigger,
            effect=effect,
            follow_up=follow_up,
            bytes_size=len(content.encode("utf-8")),
            lines=content.count("\n") + (1 if content else 0),
        )
        return content

    def write_text(self, path: Path, content: str, *, trigger: str, effect: str, follow_up: str = "none"):
        Path(path).write_text(content, encoding="utf-8")
        self.record_path(
            "write",
            Path(path),
            trigger=trigger,
            effect=effect,
            follow_up=follow_up,
            bytes_size=len(content.encode("utf-8")),
            lines=content.count("\n") + (1 if content else 0),
        )

    def report(self) -> str:
        """Return compact multi-line heartbeat report section."""
        if not self.events:
            return "Memory used this cycle: none tracked"

        counts = Counter(event["kind"] for event in self.events)
        file_events = [event for event in self.events if event["kind"] != "delegated"]
        unique_files = sorted({event["path"] for event in file_events})
        total_bytes = sum(event.get("bytes", 0) for event in file_events)
        searches = counts.get("search", 0)  # reserved for future native search instrumentation

        effects = []
        for event in self.events:
            effect = event.get("effect", "")
            if effect and effect not in effects:
                effects.append(effect)
        follow_ups = sorted({event.get("follow_up", "none") for event in self.events if event.get("follow_up") and event.get("follow_up") != "none"})

        lines = [
            "Memory used this cycle:",
            f"    Files/searches: {len(unique_files)} files, {searches} searches; "
            f"reads={counts.get('read', 0)}, scans={counts.get('scan', 0)}, "
            f"writes={counts.get('write', 0)}, delegated={counts.get('delegated', 0)}; "
            f"tracked={format_bytes(total_bytes)}",
            "    Trigger: scheduled heartbeat maintenance tasks",
            f"    Behavioral effect: {'; '.join(effects[:4])}" + (f"; +{len(effects) - 4} more" if len(effects) > 4 else ""),
            f"    Follow-up: {', '.join(follow_ups) if follow_ups else 'none'}",
        ]

        top_files = sorted(file_events, key=lambda e: e.get("bytes", 0), reverse=True)[:5]
        if top_files:
            top = "; ".join(f"{event['path']} ({event['kind']}, {format_bytes(event.get('bytes', 0))})" for event in top_files)
            lines.append(f"    Top memory artifacts: {top}")
        if counts.get("delegated", 0):
            delegated = "; ".join(event["path"] for event in self.events if event["kind"] == "delegated")
            lines.append(f"    Opaque delegated scripts: {delegated}")
        return "\n".join(lines)


def step_reflection_analysis(config, tracker: MemoryUsageTracker | None = None) -> str:
    """Run reflection-analyzer.py to detect patterns, then dispatch skill_candidate classifications."""
    log("Step 1: Reflection analysis")
    scripts_dir = Path(__file__).parent
    workspace = scripts_dir.parent
    capture = scripts_dir / "reflection-capture.py"
    analyzer = scripts_dir / "reflection-analyzer.py"
    candidate_writer = scripts_dir / "write-skill-candidate.py"
    candidates_json_path = workspace / "memory" / "heartbeat-analyzer-candidates.json"

    capture_summary = ""
    if capture.exists() and config.get("reflection", {}).get("auto_write", True):
        try:
            stale_hours = str(config.get("reflection", {}).get("auto_capture_stale_hours", 24))
            cap = subprocess.run(
                [sys.executable, str(capture), "capture", "--stale-hours", stale_hours],
                capture_output=True,
                text=True,
                timeout=45,
                cwd=str(workspace),
            )
            cap_output = (cap.stdout + cap.stderr).strip()
            if cap.returncode == 0 and cap.stdout.strip():
                data = json.loads(cap.stdout)
                if data.get("captured"):
                    capture_summary = "Reflection capture: wrote auto reflection"
                else:
                    capture_summary = f"Reflection capture: {data.get('reason', 'no capture')}"
                log(f"  {capture_summary}")
                if tracker:
                    tracker.record_external(
                        "scripts/reflection-capture.py",
                        trigger="reflection auto-capture",
                        effect=capture_summary,
                        follow_up="none",
                    )
            elif cap_output:
                log(f"  Reflection capture failed: {cap_output[:200]}")
        except Exception as e:
            log(f"  Reflection capture error: {e}")

    if not analyzer.exists():
        log("  reflection-analyzer.py not found, skipping")
        return "Reflection analysis: script not found"

    try:
        analyzer_args = [
            sys.executable,
            str(analyzer),
            "--output-candidates", str(candidates_json_path),
        ]
        result = subprocess.run(
            analyzer_args,
            capture_output=True,
            text=True,
            timeout=60,
            cwd=str(workspace),
        )
        output = (result.stdout + result.stderr).strip()
        if result.returncode == 0:
            log("  Analysis complete")
            pattern_count = output.count("candidate rule")

            # Dispatch skill_candidate classifications to write-skill-candidate.py
            candidate_parts: list[str] = []
            if candidates_json_path.exists() and candidate_writer.exists():
                try:
                    candidates_data = json.loads(candidates_json_path.read_text(encoding="utf-8"))
                    skill_candidates = candidates_data.get("skill_candidates", [])

                    # Dedup: skip patterns that already have an auto: candidate
                    candidates_md = workspace / "memory" / "skill-candidates.md"
                    existing_auto: set[str] = set()
                    if candidates_md.exists():
                        existing_text = candidates_md.read_text(encoding="utf-8")
                        existing_auto = set(
                            m.group(1) for m in
                            re.finditer(r"^name:\s*auto:(.+?)\s*$", existing_text, re.MULTILINE)
                        )

                    for sc in skill_candidates:
                        pid = sc.get("pattern_id", "")
                        if pid in existing_auto:
                            log(f"  Candidate auto:{pid} already exists — skipped")
                            continue

                        label = sc.get("label", "unnamed")
                        rule = sc.get("rule", "")
                        count = sc.get("count", 0)
                        examples = sc.get("examples", [])
                        source_refs = [ex.get("created_at", "")[:10] for ex in examples if ex.get("created_at")]

                        # Enrich: extract failure_modes and steps from pattern examples
                        failure_modes = "; ".join(
                            (ex.get("what_failed") or "")[:80]
                            for ex in examples
                            if ex.get("what_failed")
                        )
                        example_contexts = "; ".join(
                            (ex.get("context") or "")[:60]
                            for ex in examples
                            if ex.get("context")
                        )

                        trigger = f"When {label.lower()}"
                        writer_args = [
                            sys.executable, str(candidate_writer),
                            "--name", f"auto:{pid}",
                            "--trigger", trigger[:300],
                            "--steps", rule[:500],
                            "--failure_modes", failure_modes[:500],
                            "--examples", example_contexts[:300],
                            "--source_reflections", "; ".join(source_refs[:5]),
                            "--validation", f"Observed {count} times in reflections",
                            "--safety_boundaries", "auto-created from pattern detection; requires review",
                            "--status", "draft",
                        ]
                        try:
                            wr = subprocess.run(
                                writer_args,
                                capture_output=True, text=True, timeout=15,
                                cwd=str(workspace),
                            )
                            if wr.returncode == 0:
                                log(f"  Candidate auto-created: auto:{pid} (x{count})")
                                candidate_parts.append(f"auto:{pid} (x{count})")
                            else:
                                log(f"  Candidate write failed for {pid}: {wr.stderr.strip()[:120]}")
                        except Exception as e:
                            log(f"  Candidate write error for {pid}: {e}")
                except (json.JSONDecodeError, OSError) as e:
                    log(f"  Failed to read candidates JSON: {e}")

            analysis_summary = f"Reflection analysis: complete ({pattern_count} patterns found)" if pattern_count else "Reflection analysis: no patterns"
            if candidate_parts:
                analysis_summary += f" | auto-created candidates: {', '.join(candidate_parts)}"
            last_line = next((l.strip() for l in output.splitlines() if l.strip().startswith("Last reflection:")), "")
            if last_line:
                analysis_summary = f"{analysis_summary}; {last_line}"
            if tracker:
                tracker.record_external(
                    "scripts/reflection-analyzer.py",
                    trigger="reflection pattern check",
                    effect=analysis_summary,
                    follow_up="promote repeated patterns if candidates appear" if pattern_count else "none",
                )
            return f"{capture_summary}; {analysis_summary}" if capture_summary else analysis_summary
        else:
            log(f"  Analysis failed: {output[:200]}")
            return f"Reflection analysis: failed"
    except subprocess.TimeoutExpired:
        log("  Analysis timed out")
        return "Reflection analysis: timed out"
    except Exception as e:
        log(f"  Analysis error: {e}")
        return f"Reflection analysis: error"


def step_memory_scan(config, tracker: MemoryUsageTracker | None = None) -> str:
    """Check memory freshness without forcing noisy core-doc churn.

    MEMORY.md is now a stable hot index. Most real updates land in
    memory/index.md and project/concept/person pages, so heartbeat should not
    nag Tianyi just because the core file mtime is old while the wiki index is
    fresh.
    """
    log("Step 2: Memory scan")
    workspace = resolve_workspace(config)
    local_cfg = config.get("storage", {}).get("local", {})
    memory_file = workspace / local_cfg.get("memory_file", "MEMORY.md")
    index_file = workspace / "memory" / "index.md"

    if not memory_file.exists():
        log("  MEMORY.md not found")
        return "Memory scan: MEMORY.md not found"

    paths = [memory_file]
    if index_file.exists():
        paths.append(index_file)

    if tracker:
        for p in paths:
            tracker.record_path(
                "scan",
                p,
                trigger="memory freshness check",
                effect="staleness signal for whether hot memory or wiki index needs update",
                follow_up="update only if hot routing/index content is actually stale",
            )

    now = datetime.now(timezone.utc)
    memory_age_days = (now - datetime.fromtimestamp(memory_file.stat().st_mtime, tz=timezone.utc)).days
    freshest_path = max(paths, key=lambda p: p.stat().st_mtime)
    freshest_age_days = (now - datetime.fromtimestamp(freshest_path.stat().st_mtime, tz=timezone.utc)).days

    if freshest_age_days > 7:
        log(f"  Memory wiki is {freshest_age_days} days old — consider updating")
        return f"Memory scan: memory wiki is {freshest_age_days} days old (consider updating)"

    if freshest_path == memory_file:
        log(f"  MEMORY.md is fresh ({memory_age_days} days old)")
        return f"Memory scan: MEMORY.md is fresh ({memory_age_days} days old)"

    log(f"  Memory wiki index is fresh ({freshest_age_days} days old); MEMORY.md hot index is stable ({memory_age_days} days old)")
    return f"Memory scan: memory/index.md is fresh ({freshest_age_days} days old); MEMORY.md hot index stable ({memory_age_days} days old)"


def step_log_compress(config, tracker: MemoryUsageTracker | None = None) -> str:
    """Check logs directory size and suggest compression if needed."""
    log("Step 3: Log compression check")
    workspace = resolve_workspace(config)
    local_cfg = config.get("storage", {}).get("local", {})
    logs_dir = workspace / local_cfg.get("logs_dir", "memory/logs")

    if not logs_dir.exists():
        log("  Logs directory not found")
        return "Log compression: no logs directory"

    total_lines = 0
    total_size = 0
    file_count = 0

    for f in logs_dir.iterdir():
        if f.is_file() and f.suffix in (".md", ".log", ".jsonl", ".txt"):
            file_size = f.stat().st_size
            total_size += file_size
            file_count += 1
            try:
                line_count = sum(1 for _ in open(f, encoding="utf-8", errors="ignore"))
                total_lines += line_count
                if tracker:
                    tracker.record_path(
                        "scan",
                        f,
                        trigger="log compression budget check",
                        effect="decide whether memory logs need compression",
                        follow_up="run compress-memory.py if over threshold",
                        bytes_size=file_size,
                        lines=line_count,
                    )
            except OSError:
                pass

    size_mb = total_size / (1024 * 1024)

    if total_lines > 500:
        log(f"  {file_count} log files, {total_lines} lines ({size_mb:.1f} MB) — compression recommended")
        return f"Log compression: {total_lines} lines across {file_count} files — run compress-memory.py"
    else:
        log(f"  {file_count} log files, {total_lines} lines ({size_mb:.1f} MB) — OK")
        return f"Log compression: OK ({total_lines} lines, {size_mb:.1f} MB)"



def step_wiki_maintenance(config, tracker: MemoryUsageTracker | None = None) -> str:
    """Run deterministic LLM Wiki maintenance and promotion-candidate scan."""
    log("Step 4: Wiki maintenance")
    scripts_dir = Path(__file__).parent
    maint = scripts_dir / "wiki-maintenance.py"

    if not maint.exists():
        log("  wiki-maintenance.py not found, skipping")
        return "Wiki maintenance: script not found"

    try:
        result = subprocess.run(
            [sys.executable, str(maint), "--days", "3", "--max-proposals", "3"],
            capture_output=True,
            text=True,
            timeout=120,
            cwd=str(scripts_dir.parent),
        )
        output = (result.stdout + result.stderr).strip()
        indexed = "0"
        proposals = "0"
        promoted_count = "0"
        reindexed = "0"
        promoted_items: list[str] = []
        lint = "attention" if result.returncode else "ok"
        for line in output.splitlines():
            if line.startswith("- Indexed project pages:"):
                indexed = line.split(":", 1)[1].strip()
            elif line.startswith("- Promotion proposals created:"):
                proposals = line.split(":", 1)[1].strip()
            elif line.startswith("- Auto-promoted to wiki:"):
                promoted_count = line.split(":", 1)[1].strip()
            elif line.startswith("- Reindexed pages:"):
                reindexed = line.split(":", 1)[1].strip()
            elif line.startswith("  - [") and "]" in line:
                promoted_items.append(line.strip())
            elif line.startswith("- Lint:"):
                lint = line.split(":", 1)[1].strip()
        log(f"  Wiki maintenance complete: indexed={indexed}, proposals={proposals}, promoted={promoted_count}, reindexed={reindexed}, lint={lint}")
        report_line = f"Wiki maintenance: indexed {indexed}, proposals {proposals}, promoted {promoted_count}, reindexed {reindexed}, lint {lint}"
        if tracker:
            tracker.record_external(
                "scripts/wiki-maintenance.py",
                trigger="wiki maintenance / promotion candidate scan",
                effect=f"indexed {indexed}, proposals {proposals}, promoted {promoted_count}, reindexed {reindexed}, lint {lint}",
                follow_up="review proposals or lint issues" if proposals != "0" or lint not in ("ok", "0") else "none",
            )
        if promoted_items:
            report_line += "\n    Promoted:" + "\n    ".join([""] + promoted_items[:10])
            if len(promoted_items) > 10:
                report_line += f"\n    ... and {len(promoted_items) - 10} more"
        return report_line
    except subprocess.TimeoutExpired:
        log("  Wiki maintenance timed out")
        return "Wiki maintenance: timed out"
    except Exception as e:
        log(f"  Wiki maintenance error: {e}")
        return "Wiki maintenance: error"

def stable_task_id(project: str, task_text: str) -> str:
    """Stable short id for TODO task matching across heartbeat runs."""
    normalized = re.sub(r"\s+", " ", task_text).strip()
    digest = hashlib.sha1(f"{project}:{normalized}".encode("utf-8")).hexdigest()[:12]
    return f"hb_{digest}"


def classify_dispatchability(task_text: str) -> tuple[str, str]:
    """Classify whether a ready TODO is actionable for autonomous heartbeat dispatch.

    Heartbeat may skip gated/deferred tasks, but it must keep looking until it
    finds actionable work. This prevents one future/conditional TODO from
    occupying the top recommendation slot every run.
    """
    text = task_text.lower()
    if any(marker in text for marker in (
        "future optimization only",
        "future/deferred",
        "future optimization",
        "未来评估",
        "后评估",
        "不阻塞",
    )):
        return "deferred", "future/deferred optimization"
    if any(marker in text for marker in (
        "if tianyi wants",
        "requires tianyi",
        "awaiting tianyi",
        "needs tianyi",
        "需天懿",
        "需要天懿",
        "天懿确认",
        "确认后",
        "需要确认",
    )):
        return "waiting_input", "requires Tianyi confirmation/input"
    if re.search(r"status:\s*(waiting|waiting_input|blocked|blocked_on|waiting_hanbing|waiting_parent|pending_hanbing)", text):
        return "waiting_input", "explicit waiting/blocked status"
    return "actionable", "ready for autonomous heartbeat dispatch"


def step_project_queue(config, tracker: MemoryUsageTracker | None = None) -> str:
    """Scan memory/projects/*/TODO.md for ready tasks and write durable dispatch state."""
    log("Step 5: Project queue scan")
    workspace = resolve_workspace(config)
    projects_dir = workspace / "memory" / "projects"

    if not projects_dir.exists():
        log("  No projects directory")
        return "Project queue: no projects directory"

    dispatch_cfg = config.get("heartbeat", {}).get("dispatch", {})
    excluded_projects = {
        str(project).strip().lower()
        for project in dispatch_cfg.get("exclude_projects", [])
        if str(project).strip()
    }

    ready_tasks = []
    for todo_path in sorted(projects_dir.glob("*/TODO.md")):
        project = todo_path.parent.name
        if project.startswith("_"):
            continue  # skip templates
        if project.lower() in excluded_projects:
            continue  # explicitly excluded from heartbeat dispatch
        try:
            if tracker:
                content = tracker.read_text(
                    todo_path,
                    trigger="project TODO queue scan",
                    effect="select ready heartbeat-dispatch tasks",
                    follow_up="dispatch recommended ready tasks",
                )
            else:
                content = todo_path.read_text()
        except OSError:
            continue

        # Parse simple markdown checklist: - [ ] task (status: ready)
        for line_no, line in enumerate(content.splitlines(), start=1):
            stripped = line.strip()
            if stripped.startswith("- [ ]"):
                task_text = stripped[6:].strip()
                status = "ready"  # default, overridden by tags
                priority = "medium"
                lower_task = task_text.lower()
                if "status: blocked" in lower_task or "status: waiting" in lower_task:
                    status = "blocked"
                elif "status: in_progress" in lower_task:
                    status = "in_progress"
                elif "status: done" in lower_task:
                    status = "done"
                if "priority: hot" in lower_task:
                    priority = "hot"
                elif "priority: high" in lower_task:
                    priority = "high"
                elif "priority: low" in lower_task:
                    priority = "low"

                # Clean tags from display
                display = re.sub(r'\(status:\s*[^)]+\)', '', task_text, flags=re.I).strip()
                display = re.sub(r'\(priority:\s*[^)]+\)', '', display, flags=re.I).strip()

                task_entry = {
                    # Status/priority tags change as heartbeat claims/fails/retries
                    # tasks. Base the durable id on the cleaned task text so a
                    # failed retry returns to the same queue slot instead of
                    # becoming a new task id.
                    "task_id": stable_task_id(project, display),
                    "project": project,
                    "task": display,
                    "status": status,
                    "priority": priority,
                    "todo_path": str(todo_path.relative_to(workspace)),
                    "line_no": line_no,
                    "raw": stripped,
                }
                if status == "ready":
                    ready_tasks.append(task_entry)

    # Sort: hot > high > medium > low
    prio_order = {"hot": 0, "high": 1, "medium": 2, "low": 3}
    ready_tasks.sort(key=lambda t: prio_order.get(t["priority"], 2))

    for task in ready_tasks:
        dispatch_status, dispatch_reason = classify_dispatchability(task.get("raw") or task.get("task") or "")
        task["dispatch_status"] = dispatch_status
        task["dispatch_reason"] = dispatch_reason

    todo_count = len(list(projects_dir.glob('*/TODO.md')))
    log(f"  Found {len(ready_tasks)} ready tasks across {todo_count} projects")

    max_dispatch = int(dispatch_cfg.get("max_per_cycle", 2))
    actionable_tasks = [t for t in ready_tasks if t.get("dispatch_status") == "actionable"]
    skipped_recommendation_candidates = [t for t in ready_tasks if t.get("dispatch_status") != "actionable"]
    # Memory Optimization is a standing self-improvement project requested by
    # Tianyi: while it has ready tasks, every heartbeat should consider at
    # least one item from it, instead of letting louder production projects
    # starve the memory-system work.
    recommended = actionable_tasks[:max_dispatch]
    memory_opt_tasks = [t for t in actionable_tasks if t.get("project") == "memory-optimization"]
    if memory_opt_tasks and not any(t.get("project") == "memory-optimization" for t in recommended):
        if max_dispatch <= 0:
            recommended = memory_opt_tasks[:1]
        elif len(recommended) < max_dispatch:
            recommended.append(memory_opt_tasks[0])
        else:
            recommended = recommended[: max_dispatch - 1] + [memory_opt_tasks[0]]
    dispatch_state = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "workspace": str(workspace),
        "ready_count": len(ready_tasks),
        "actionable_count": len(actionable_tasks),
        "deferred_count": len(skipped_recommendation_candidates),
        "todo_file_count": todo_count,
        "max_per_cycle": max_dispatch,
        "recommended_dispatch": recommended,
        "skipped_recommendation_candidates": skipped_recommendation_candidates[:20],
        "ready_tasks": ready_tasks,
        "next_agent_action": "Spawn sub-agents for actionable recommended_dispatch, then run scripts/heartbeat-dispatch.py claim <task_id> with the returned session/run ids. Do not repeatedly skip deferred/waiting tasks; they are stored in skipped_recommendation_candidates.",
    }
    dispatch_path = workspace / "memory" / "heartbeat-dispatch.json"
    dispatch_path.parent.mkdir(parents=True, exist_ok=True)
    dispatch_content = json.dumps(dispatch_state, indent=2, ensure_ascii=False) + "\n"
    if tracker:
        tracker.write_text(
            dispatch_path,
            dispatch_content,
            trigger="project TODO queue scan",
            effect="persist recommended dispatch state for agents",
            follow_up="spawn sub-agents for recommended tasks",
        )
    else:
        dispatch_path.write_text(dispatch_content, encoding="utf-8")
    log(f"  Wrote dispatch state: {dispatch_path.relative_to(workspace)}")

    # Output compact dispatch JSON for AI to consume in the current run.
    print("\n[dispatch]")
    print(json.dumps(recommended, indent=2, ensure_ascii=False))
    print("[/dispatch]\n")

    if ready_tasks:
        return f"Project queue: {len(ready_tasks)} ready tasks, {len(actionable_tasks)} actionable, {len(recommended)} recommended, {len(skipped_recommendation_candidates)} deferred/waiting, dispatch state written"
    else:
        return "Project queue: no ready tasks, dispatch state written"


def step_daily_review_feishu_replies(config, tracker: MemoryUsageTracker | None = None) -> str:
    """Route exact Feishu DM approval replies for Daily Session Review."""
    log("Step: Daily review Feishu reply route")
    workspace = resolve_workspace(config)
    script = workspace / "scripts" / "daily-session-review-feishu-reply-poll.py"
    if not script.exists():
        log("  daily-session-review-feishu-reply-poll.py not found, skipping")
        return "Daily review replies: script not found"
    cfg = config.get("heartbeat", {}).get("daily_review_feishu_replies", {})
    if cfg.get("enabled") is False:
        return "Daily review replies: disabled"
    args = [
        sys.executable,
        str(script),
        "--since-minutes",
        str(int(cfg.get("since_minutes", 24 * 60))),
        "--page-size",
        str(int(cfg.get("page_size", 30))),
    ]
    target_user = cfg.get("target_user") or os.environ.get("DAILY_REVIEW_APPROVAL_TARGET")
    if target_user:
        args.extend(["--target-user", str(target_user)])
    if cfg.get("no_reply"):
        args.append("--no-reply")
    try:
        result = subprocess.run(
            args,
            cwd=str(workspace),
            capture_output=True,
            text=True,
            timeout=int(cfg.get("timeout_seconds", 90)),
        )
        if tracker:
            tracker.record_external(
                "scripts/daily-session-review-feishu-reply-poll.py",
                trigger="heartbeat daily review Feishu reply route",
                effect="routes exact YYYY-MM-DD N kind approvals through daily-session-review-decision.py",
                follow_up="review errors if route reports failures",
            )
        raw = (result.stdout or result.stderr or "").strip()
        try:
            data = json.loads(raw or "{}")
        except Exception:
            data = {}
        handled = int(data.get("handled_count") or 0)
        scanned = int(data.get("scanned") or 0)
        errors = data.get("errors") or []
        if result.returncode != 0 or errors:
            detail = errors[0].get("error") if errors and isinstance(errors[0], dict) else (raw.splitlines()[-1] if raw else f"exit {result.returncode}")
            log(f"  Daily review reply route attention: {detail}")
            return f"Daily review replies: attention ({handled} handled, {len(errors)} errors)"
        log(f"  Daily review reply route: scanned={scanned}, handled={handled}")
        return f"Daily review replies: scanned {scanned}, handled {handled}"
    except subprocess.TimeoutExpired:
        log("  Daily review reply route timed out")
        return "Daily review replies: timed out"
    except Exception as e:
        log(f"  Daily review reply route error: {e}")
        return "Daily review replies: error"


def step_token_budget_check(config, tracker: MemoryUsageTracker | None = None) -> str:
    """Check GPT-5.5 token budget against thresholds; alert if critical."""
    log("Step: Token budget check")
    workspace = resolve_workspace(config)
    script = workspace / "scripts" / "token-budget-check.py"
    if not script.exists():
        log("  token-budget-check.py not found, skipping")
        return "Token budget: script not found"
    try:
        result = subprocess.run(
            [sys.executable, str(script), "--json"],
            cwd=str(workspace),
            capture_output=True,
            text=True,
            timeout=120,
        )
        data = {}
        try:
            data = json.loads(result.stdout or "{}")
        except Exception:
            pass
        status = data.get("status", "error")
        gpt55_total = data.get("gpt55_tokens", {}).get("total", 0)
        warning_t = data.get("thresholds", {}).get("weekly_warning_tokens", 0)
        critical_t = data.get("thresholds", {}).get("weekly_critical_tokens", 0)
        pct_warning = (gpt55_total / warning_t * 100) if warning_t > 0 else 0
        pct_critical = (gpt55_total / critical_t * 100) if critical_t > 0 else 0
        if status == "critical":
            log(f"  CRITICAL: GPT-5.5 at {gpt55_total:,} tokens ({pct_critical:.0f}% of critical)")
            if tracker:
                tracker.record_external(
                    "scripts/token-budget-check.py",
                    trigger="heartbeat token budget check",
                    effect=f"CRITICAL: GPT-5.5 at {gpt55_total:,} tokens",
                    follow_up="alert Tianyi; halt non-essential GPT-5.5 work",
                )
            return f"Token budget: CRITICAL — GPT-5.5 at {gpt55_total:,} tokens ({pct_critical:.0f}% of critical {critical_t:,}) — HALT non-essential GPT-5.5"
        elif status == "warning":
            log(f"  WARNING: GPT-5.5 at {gpt55_total:,} tokens ({pct_warning:.0f}% of warning)")
            if tracker:
                tracker.record_external(
                    "scripts/token-budget-check.py",
                    trigger="heartbeat token budget check",
                    effect=f"WARNING: GPT-5.5 at {gpt55_total:,} tokens",
                    follow_up="throttle GPT-5.5; prefer DeepSeek",
                )
            return f"Token budget: WARNING — GPT-5.5 at {gpt55_total:,} tokens ({pct_warning:.0f}% of warning {warning_t:,})"
        else:
            log(f"  OK: GPT-5.5 at {gpt55_total:,} tokens")
            if tracker:
                tracker.record_external(
                    "scripts/token-budget-check.py",
                    trigger="heartbeat token budget check",
                    effect=f"OK: GPT-5.5 at {gpt55_total:,} tokens",
                    follow_up="none",
                )
            return f"Token budget: OK — GPT-5.5 at {gpt55_total:,} tokens ({pct_warning:.0f}% of warning)"
    except subprocess.TimeoutExpired:
        log("  Token budget check timed out")
        return "Token budget: timed out"
    except Exception as e:
        log(f"  Token budget check error: {e}")
        return f"Token budget: error ({e})"


def step_makaron_marketing_image(config) -> str:
    """Generate next Xiaohongshu cover image via Makaron."""
    log("Step 5: Makaron marketing image generation")
    scripts_dir = Path(__file__).parent
    producer = scripts_dir / "makaron-marketing-produce.py"

    if not producer.exists():
        log("  makaron-marketing-produce.py not found, skipping")
        return "Makaron marketing: script not found"

    try:
        result = subprocess.run(
            [sys.executable, str(producer)],
            capture_output=True,
            text=True,
            timeout=180,
            cwd=str(scripts_dir.parent),
        )
        output = (result.stdout + result.stderr).strip()
        status_line = ""
        for line in output.splitlines():
            if "→" in line:
                status_line = line.split("→", 1)[-1].strip()
            if "✓" in line or "✗" in line:
                log(f"  {line.strip()}")
        if result.returncode == 0:
            log(f"  Done: {status_line}" if status_line else "  Done")
            return f"Makaron marketing: {status_line}" if status_line else "Makaron marketing: done"
        else:
            log(f"  Failed")
            return f"Makaron marketing: failed"
    except subprocess.TimeoutExpired:
        log("  Timed out")
        return "Makaron marketing: timed out"
    except Exception as e:
        log(f"  Error: {e}")
        return f"Makaron marketing: error"


def step_skill_dashboard(config, tracker: MemoryUsageTracker | None = None) -> str:
    """Run the V Learning Loop dashboard to show pending candidates and recent decisions."""
    log("Step: Skill dashboard")
    workspace = resolve_workspace(config)
    script = workspace / "scripts" / "skill-dashboard.py"
    if not script.exists():
        log("  skill-dashboard.py not found, skipping")
        return "Skill dashboard: script not found"

    try:
        # Get compact output
        result = subprocess.run(
            [sys.executable, str(script), "--compact"],
            cwd=str(workspace),
            capture_output=True,
            text=True,
            timeout=30,
        )
        compact = (result.stdout or "").strip()
        if result.returncode != 0:
            log(f"  Failed: {(result.stderr or '').strip()[:200]}")
            return f"Skill dashboard: failed"
        log(f"  {compact}")
        if tracker:
            tracker.record_external(
                "scripts/skill-dashboard.py",
                trigger="heartbeat skill dashboard",
                effect=compact,
                follow_up="review pending candidates if any",
            )
        return f"Skill dashboard: {compact}"
    except subprocess.TimeoutExpired:
        log("  Timed out")
        return "Skill dashboard: timed out"
    except Exception as e:
        log(f"  Error: {e}")
        return f"Skill dashboard: error"


def step_vsync_import(config, tracker: MemoryUsageTracker | None = None) -> str:
    """Pull VSync hub snapshots into quarantine candidates; never promote."""
    log("Step: VSync import")
    workspace = resolve_workspace(config)
    script = workspace / "scripts" / "vsync-pull-v-from-versa.sh"
    if not script.exists():
        log("  vsync-pull-v-from-versa.sh not found, skipping")
        return "VSync import: script not found"
    try:
        result = subprocess.run(
            [str(script)],
            cwd=str(workspace),
            capture_output=True,
            text=True,
            timeout=300,
        )
        if tracker:
            tracker.record_external(
                "scripts/vsync-pull-v-from-versa.sh",
                trigger="heartbeat vsync import",
                effect="pulls v-sync-hub into quarantine without promotion",
                follow_up="review candidates before promotion",
            )
        if result.returncode != 0:
            output = (result.stderr or result.stdout or "").strip().splitlines()
            last = output[-1] if output else "no output"
            log(f"  Failed: {last}")
            return f"VSync import: failed ({last})"
        log_path = workspace / "memory" / "imports" / "v-from-versa" / "pull.log"
        if log_path.exists():
            lines = log_path.read_text(encoding="utf-8", errors="ignore").splitlines()
            if len(lines) >= 2:
                return "VSync import: " + "; ".join(lines[-2:])
        return "VSync import: done"
    except subprocess.TimeoutExpired:
        log("  Timed out")
        return "VSync import: timed out"
    except Exception as e:
        log(f"  Error: {e}")
        return f"VSync import: error"


def step_vsync_a2a_check(config, tracker: MemoryUsageTracker | None = None) -> str:
    """Check deterministic A2A inbox for private-v; never auto-execute."""
    log("Step: VSync A2A inbox check")
    workspace = resolve_workspace(config)
    script = workspace / "scripts" / "vsync-a2a-check.py"
    if not script.exists():
        return "A2A inbox: script not found"
    try:
        result = subprocess.run(
            [sys.executable, str(script)],
            cwd=str(workspace),
            capture_output=True,
            text=True,
            timeout=120,
        )
        if tracker:
            tracker.record_external(
                "scripts/vsync-a2a-check.py",
                trigger="heartbeat a2a inbox check",
                effect="checks v-sync-hub private-v inbox without executing tasks",
                follow_up="reply or promote only after review",
            )
        out = (result.stdout or result.stderr or "").strip().splitlines()
        last = out[-1] if out else "no output"
        if result.returncode != 0:
            return f"A2A inbox: failed ({last})"
        if out and out[0].startswith("A2A inbox:"):
            return out[0]
        return f"A2A inbox: {last}"
    except subprocess.TimeoutExpired:
        return "A2A inbox: timeout"
    except Exception as e:
        return f"A2A inbox: error ({e})"


def send_notification(report: str, config: dict):
    """Send heartbeat report via configured notification backend."""
    notifications = config.get("notifications", {})
    backend = notifications.get("backend", "none")

    if backend == "telegram" or notifications.get("telegram", {}).get("enabled"):
        import urllib.request

        telegram_cfg = notifications.get("telegram", {})
        bot_token = telegram_cfg.get("bot_token", "") or os.environ.get("TELEGRAM_BOT_TOKEN", "")
        chat_id = telegram_cfg.get("chat_id", "") or os.environ.get("TELEGRAM_CHAT_ID", "")

        if bot_token and chat_id:
            payload = {"chat_id": chat_id, "text": report}
            req = urllib.request.Request(
                f"https://api.telegram.org/bot{bot_token}/sendMessage",
                data=json.dumps(payload).encode(),
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            try:
                with urllib.request.urlopen(req, timeout=10):
                    log("  Notification sent via Telegram")
            except Exception as e:
                log(f"  Telegram notification failed: {e}")


def main():
    start = datetime.now()
    log(f"=== Knight Heartbeat started {start.strftime('%Y-%m-%d %H:%M')} ===")

    config = load_config()
    workspace = resolve_workspace(config)
    tracker = MemoryUsageTracker(workspace)
    heartbeat_cfg = config.get("heartbeat", {})
    tasks = heartbeat_cfg.get("tasks", ["reflection_analysis", "memory_scan", "log_compress", "skill_dashboard", "project_queue", "token_budget_check"])
    if heartbeat_cfg.get("daily_review_feishu_replies", {}).get("enabled", True) and "daily_review_feishu_replies" not in tasks:
        tasks.append("daily_review_feishu_replies")
    if "skill_dashboard" not in tasks and "v_learning_loop_dashboard" not in tasks:
        # Auto-include skill dashboard unless explicitly excluded or disabled
        skill_dashboard_enabled = heartbeat_cfg.get("skill_dashboard", {}).get("enabled", True)
        if skill_dashboard_enabled:
            tasks.append("skill_dashboard")

    results = []

    if "reflection_analysis" in tasks:
        results.append(step_reflection_analysis(config, tracker))

    if "memory_scan" in tasks:
        results.append(step_memory_scan(config, tracker))

    if "log_compress" in tasks:
        results.append(step_log_compress(config, tracker))

    if "wiki_maintenance" in tasks:
        results.append(step_wiki_maintenance(config, tracker))

    if "skill_dashboard" in tasks or "v_learning_loop_dashboard" in tasks:
        results.append(step_skill_dashboard(config, tracker))

    if "project_queue" in tasks:
        results.append(step_project_queue(config, tracker))

    if "daily_review_feishu_replies" in tasks:
        results.append(step_daily_review_feishu_replies(config, tracker))

    if "makaron_marketing_image" in tasks:
        results.append(step_makaron_marketing_image(config))

    if "vsync_import" in tasks:
        results.append(step_vsync_import(config, tracker))

    if "vsync_a2a_check" in tasks:
        results.append(step_vsync_a2a_check(config, tracker))

    if "token_budget_check" in tasks:
        results.append(step_token_budget_check(config, tracker))

    now_str = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    report_lines = [f"[knight] Heartbeat Report — {now_str}", ""]
    for r in results:
        if r:
            report_lines.append(f"  * {r}")
    report_lines.append(f"\n  * {tracker.report().replace(chr(10), chr(10) + '    ')}")

    elapsed = (datetime.now() - start).seconds
    report_lines.append(f"\n  Completed in {elapsed}s")

    report = "\n".join(report_lines)
    print(report)

    send_notification(report, config)

    log(f"=== Knight Heartbeat complete ({elapsed}s) ===")


if __name__ == "__main__":
    main()
