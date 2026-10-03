import { useEffect, useReducer, useRef, useState } from "react";
import { servedBy } from "@shared/ipc";
import type {
	CostUpdate,
	OverlayNav,
	QaSnapshot,
	QuestionType,
	SessionState,
	SessionStatus,
	TranscriptUpdate,
} from "@shared/ipc";
import { APP_MODE_LABELS, type Settings } from "@shared/settings";
import { PROJECT_STATUS_LABELS, type WorkPick } from "@shared/work";
import { keys } from "../../shared/keys";
import { Markdown } from "../../shared/Markdown";
import { AskBar } from "./AskBar";

const DOT: Record<SessionStatus | "thinking", { cls: string; label: string }> =
	{
		idle: { cls: "bg-muted", label: "Idle" },
		starting: { cls: "bg-warn animate-pulse", label: "Starting" },
		listening: { cls: "bg-ok", label: "Listening" },
		reconnecting: { cls: "bg-warn animate-pulse", label: "Reconnecting" },
		error: { cls: "bg-bad", label: "Error" },
		thinking: { cls: "bg-accent animate-pulse", label: "Thinking" },
	};

const TYPE_LABEL: Record<QuestionType, string> = {
	behavioral: "Behavioral",
	technical: "Technical",
	coding: "Coding",
	system_design: "System design",
	situational: "Situational",
	smalltalk: "Small talk",
	other: "Question",
	status: "Status",
	work: "Work",
};

interface QaState {
	qas: QaSnapshot[];
	/** Index being viewed; null follows the latest answer. */
	index: number | null;
}

type QaAction =
	| { type: "load"; qas: QaSnapshot[] }
	| { type: "reset" }
	| {
			type: "question";
			qa: Pick<
				QaSnapshot,
				"id" | "question" | "type" | "style" | "screenshots" | "project"
			>;
	  }
	| { type: "token"; id: string; delta: string }
	| { type: "done"; id: string; truncated: boolean; servedBy?: string }
	| { type: "error"; id: string; message: string }
	| { type: "nav"; dir: OverlayNav };

function patch(
	qas: QaSnapshot[],
	id: string,
	fn: (q: QaSnapshot) => QaSnapshot,
): QaSnapshot[] {
	const i = qas.findIndex((q) => q.id === id);
	if (i === -1) return qas;
	const next = qas.slice();
	next[i] = fn(qas[i]);
	return next;
}

function reducer(state: QaState, a: QaAction): QaState {
	switch (a.type) {
		case "load":
			return { qas: a.qas, index: null };
		case "reset":
			return { qas: [], index: null };
		case "question": {
			const fresh: QaSnapshot = { ...a.qa, answer: "", status: "thinking" };
			const exists = state.qas.some((q) => q.id === a.qa.id);
			const qas = exists
				? patch(state.qas, a.qa.id, () => fresh)
				: [...state.qas, fresh];
			// Jump to the answer that just (re)started.
			const i = qas.findIndex((q) => q.id === a.qa.id);
			return { qas, index: i === qas.length - 1 ? null : i };
		}
		case "token":
			return {
				...state,
				qas: patch(state.qas, a.id, (q) => ({
					...q,
					status: "streaming",
					answer: q.answer + a.delta,
				})),
			};
		case "done":
			return {
				...state,
				qas: patch(state.qas, a.id, (q) => ({
					...q,
					status: "done",
					truncated: a.truncated,
					servedBy: a.servedBy,
				})),
			};
		case "error":
			return {
				...state,
				qas: patch(state.qas, a.id, (q) => ({
					...q,
					status: "error",
					error: a.message,
				})),
			};
		case "nav": {
			if (state.qas.length === 0) return state;
			const last = state.qas.length - 1;
			const cur = state.index ?? last;
			const next = Math.min(
				last,
				Math.max(0, cur + (a.dir === "prev" ? -1 : 1)),
			);
			return { ...state, index: next === last ? null : next };
		}
	}
}

export function Overlay() {
	const [settings, setSettings] = useState<Settings | null>(null);
	const [session, setSession] = useState<SessionState>({
		status: "idle",
		elapsed: 0,
		cost: 0,
	});
	const [lastHeard, setLastHeard] = useState<TranscriptUpdate | null>(null);
	const [micHeard, setMicHeard] = useState("");
	const [notice, setNotice] = useState<string | null>(null);
	const [pendingShots, setPendingShots] = useState<string[]>([]);
	const [cost, setCost] = useState<CostUpdate | null>(null);
	/** Work Mode status quick-pick (FR-W6/W9), and the highlighted row. */
	const [pick, setPick] = useState<WorkPick | null>(null);
	const [pickIndex, setPickIndex] = useState(0);
	const [{ qas, index }, dispatch] = useReducer(reducer, {
		qas: [],
		index: null,
	});
	const scroller = useRef<HTMLElement>(null);
	/** List view: keep following new text while the user is at the bottom; stop once they scroll up to read. */
	const atBottom = useRef(true);

	useEffect(() => {
		const { api } = window;
		void api.settings.get().then(setSettings);
		void api.session.getState().then(setSession);
		void api.answers
			.list()
			.then((list) => dispatch({ type: "load", qas: list }));
		void api.screen.pending().then((p) => setPendingShots(p.thumbs ?? []));
		void api.cost.get().then(setCost);
		const offs = [
			api.settings.onChanged(setSettings),
			api.session.onState(setSession),
			api.session.onTranscript((u) => {
				if (u.source === "loopback") setLastHeard(u);
				// Live line for voice questions; cleared once the utterance is sent as a question.
				else setMicHeard(u.isFinal ? "" : u.text);
			}),
			api.answers.onReset(() => dispatch({ type: "reset" })),
			api.answers.onQuestion((q) => {
				setNotice(null);
				setPick(null);
				dispatch({ type: "question", qa: q });
			}),
			api.work.onPick((p) => {
				setNotice(null);
				setPick(p);
				setPickIndex(0);
				// Number keys pick a project, so they mustn't go to the ask box.
				(document.activeElement as HTMLElement | null)?.blur();
			}),
			api.answers.onToken((t) =>
				dispatch({ type: "token", id: t.id, delta: t.delta }),
			),
			api.answers.onDone((d) =>
				dispatch({
					type: "done",
					id: d.id,
					truncated: d.truncated,
					servedBy: servedBy(d.usage),
				}),
			),
			api.answers.onError((e) =>
				dispatch({ type: "error", id: e.id, message: e.message }),
			),
			api.answers.onNav((dir) => dispatch({ type: "nav", dir })),
			api.answers.onNotice(setNotice),
			api.screen.onPending((p) => setPendingShots(p.thumbs ?? [])),
			api.cost.onUpdate(setCost),
		];
		return () => offs.forEach((off) => off());
	}, []);

	const viewIndex = index ?? qas.length - 1;
	const qa = qas[viewIndex] as QaSnapshot | undefined;
	const view = settings?.overlay.view ?? "single";
	const latest = qas.at(-1);

	// Single view: start each newly viewed answer at the top.
	useEffect(() => {
		if (view === "single") scroller.current?.scrollTo({ top: 0 });
	}, [qa?.id, view]);

	// List view, prev/next: bring that Q&A to the top.
	useEffect(() => {
		if (view !== "list" || index === null) return;
		scroller.current
			?.querySelector(`[data-qa="${index}"]`)
			?.scrollIntoView({ block: "start", behavior: "smooth" });
	}, [index, view]);

	// List view: a new (or regenerated) question jumps into view; streaming text is followed only from the bottom.
	useEffect(() => {
		if (view !== "list" || index !== null || !latest) return;
		scroller.current
			?.querySelector(`[data-qa="${qas.length - 1}"]`)
			?.scrollIntoView({ block: "start" });
		atBottom.current = true;
	}, [latest?.id, latest?.status === "thinking", view]);
	useEffect(() => {
		const el = scroller.current;
		if (view !== "list" || index !== null || !el || !atBottom.current) return;
		el.scrollTo({ top: el.scrollHeight });
	}, [latest?.answer.length, view]);

	const setView = (next: "single" | "list") =>
		void window.api.settings.set({ overlay: { view: next } });

	const choose = async (projectId: string) => {
		const question = pick?.question;
		setPick(null);
		try {
			const res = await window.api.work.status(
				projectId,
				question || undefined,
			);
			setNotice(res.ok ? null : res.error);
		} catch (err) {
			setNotice(err instanceof Error ? err.message : String(err));
		}
	};

	// Quick-pick keys: ↑↓ and Enter, 1–9, Esc to dismiss.
	useEffect(() => {
		if (!pick) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.target instanceof HTMLInputElement) return;
			const n = pick.projects.length;
			if (e.key === "Escape") setPick(null);
			else if (e.key === "ArrowDown") setPickIndex((i) => (i + 1) % n);
			else if (e.key === "ArrowUp") setPickIndex((i) => (i - 1 + n) % n);
			else if (e.key === "Enter") void choose(pick.projects[pickIndex].id);
			else if (/^[1-9]$/.test(e.key) && Number(e.key) <= n)
				void choose(pick.projects[Number(e.key) - 1].id);
			else return;
			e.preventDefault();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	});

	const act = async (fn: () => Promise<{ ok: boolean; error?: string }>) => {
		const res = await fn();
		setNotice(res.ok ? null : (res.error ?? null));
	};

	const theme = settings?.overlay.theme ?? "dark";
	const fontSize = settings?.overlay.fontSize ?? 15;
	const busy = latest?.status === "thinking" || latest?.status === "streaming";
	const dot = DOT[busy ? "thinking" : session.status];
	const autoAnswer = settings?.detection.autoAnswer ?? true;
	const mode = settings?.mode ?? "work";

	return (
		<div
			data-theme={theme}
			className="ov flex h-screen flex-col overflow-hidden rounded-xl"
			style={{ fontSize }}
		>
			<header className="drag ov-line flex items-center gap-2 border-b px-3 py-1.5 text-xs">
				<span className={`size-2 rounded-full ${dot.cls}`} title={dot.label} />
				<span className="ov-muted font-medium">{dot.label}</span>
				<span
					className="ov-tag ov-muted rounded px-1.5 py-px text-[10px] font-medium tracking-wide uppercase"
					title="Mode (switch on the Session tab)"
				>
					{APP_MODE_LABELS[mode]}
				</span>

				{qas.length > 0 && (
					<div className="no-drag ml-2 flex items-center gap-0.5">
						<IconButton
							label={keys("Previous answer (Ctrl+Shift+←)")}
							disabled={viewIndex <= 0}
							onClick={() => dispatch({ type: "nav", dir: "prev" })}
						>
							‹
						</IconButton>
						<span className="ov-muted min-w-9 text-center font-mono text-[11px] tabular-nums">
							{viewIndex + 1}/{qas.length}
						</span>
						<IconButton
							label={keys("Next answer (Ctrl+Shift+→)")}
							disabled={viewIndex >= qas.length - 1}
							onClick={() => dispatch({ type: "nav", dir: "next" })}
						>
							›
						</IconButton>
						<IconButton
							label={
								view === "list"
									? "Show one answer at a time"
									: "Show all questions and answers"
							}
							onClick={() => setView(view === "list" ? "single" : "list")}
							pressed={view === "list"}
						>
							{view === "list" ? "▭" : "☰"}
						</IconButton>
					</div>
				)}

				<div className="no-drag ml-auto flex items-center gap-0.5">
					{mode === "work" ? (
						<TextButton
							label={keys("Status update — pick a project (Ctrl+Shift+Space)")}
							onClick={() => void act(window.api.answers.now)}
						>
							Status
						</TextButton>
					) : (
						<TextButton
							label={keys("Answer the last thing heard now (Ctrl+Shift+Space)")}
							onClick={() => void act(window.api.answers.now)}
						>
							Answer
						</TextButton>
					)}
					{qas.length > 0 && (
						<>
							<TextButton
								label={keys("Regenerate (Ctrl+Shift+R)")}
								onClick={() => void act(window.api.answers.regenerate)}
							>
								Retry
							</TextButton>
							<TextButton
								label={keys("Shorter (Ctrl+Shift+D)")}
								onClick={() => void act(window.api.answers.shorter)}
							>
								Shorter
							</TextButton>
						</>
					)}
					<IconButton
						label={keys("Open dashboard (Ctrl+Shift+O)")}
						onClick={() => void window.api.ui.toggleMain()}
					>
						⚙
					</IconButton>
					<QuitButton />
					<IconButton
						label="Hide overlay — Cue keeps running (Ctrl+Shift+H to show)"
						onClick={() => void window.api.ui.toggleOverlay()}
					>
						✕
					</IconButton>
				</div>
			</header>

			<main
				ref={scroller}
				className="min-h-0 flex-1 overflow-y-auto px-4 py-3"
				onScroll={(e) => {
					const el = e.currentTarget;
					atBottom.current =
						el.scrollHeight - el.scrollTop - el.clientHeight < 40;
				}}
			>
				{pick && (
					<StatusPick
						pick={pick}
						index={pickIndex}
						onChoose={(id) => void choose(id)}
						onClose={() => setPick(null)}
					/>
				)}
				{qa && view === "list" ? (
					<ol className="flex flex-col">
						{qas.map((q, i) => (
							<li
								key={q.id}
								data-qa={i}
								className={`ov-line scroll-mt-2 border-b py-3 first:pt-0 last:border-b-0 ${index === i ? "ov-focus" : ""}`}
							>
								<QaView qa={q} number={i + 1} full />
							</li>
						))}
					</ol>
				) : qa ? (
					<QaView qa={qa} />
				) : lastHeard ? (
					<>
						<div className="ov-muted text-[0.75em] tracking-wide uppercase">
							Heard
						</div>
						<p className="ov-muted mt-1 line-clamp-3 leading-snug">
							{lastHeard.text}
						</p>
					</>
				) : (
					!pick && (
						<p className="ov-muted">
							{session.status === "listening"
								? mode === "work"
									? "Listening… status updates appear here when someone asks where things stand."
									: "Listening… answers will appear here."
								: "Start a session from the main window, or type / speak a question below."}
						</p>
					)
				)}
				{notice && <p className="mt-3 text-[0.85em] text-warn">{notice}</p>}
				{session.status === "error" && session.message && (
					<p className="mt-3 text-[0.9em] text-bad">{session.message}</p>
				)}
			</main>

			<AskBar
				mode={mode}
				voiceOn={Boolean(session.voiceAsk)}
				heard={session.voiceAsk ? micHeard : ""}
				pendingShots={pendingShots}
				maxShots={settings?.screen.maxScreenshots ?? 5}
				onError={setNotice}
			/>

			<footer className="ov-line ov-muted flex items-center gap-3 border-t px-3 py-1 font-mono text-[11px] tabular-nums">
				<span className="min-w-0 flex-1 truncate">{session.hint ?? ""}</span>
				{!autoAnswer && (
					<span title={keys("Auto-answer is off (Ctrl+Shift+A)")}>auto off</span>
				)}
				<span
					className={
						cost?.status === "capped"
							? "text-bad"
							: cost?.status === "warn"
								? "text-warn"
								: ""
					}
					title={
						cost?.capUsd
							? `Session cost (cap $${cost.capUsd.toFixed(2)}${cost.status === "capped" ? " reached — using fast models" : ""})`
							: "Session cost"
					}
				>
					${(cost?.usd ?? 0).toFixed(2)}
				</span>
			</footer>
		</div>
	);
}

/** `number` + `full` for the list view: numbered, and the whole question instead of two lines. */
function QaView({
	qa,
	number,
	full,
}: {
	qa: QaSnapshot;
	number?: number;
	full?: boolean;
}) {
	return (
		<article>
			<div className="ov-muted flex items-baseline gap-2 text-[0.85em] leading-snug">
				{number !== undefined && (
					<span className="shrink-0 font-mono text-[0.85em] tabular-nums">
						{number}.
					</span>
				)}
				<span className="ov-tag shrink-0 rounded px-1.5 py-px text-[0.8em] font-medium tracking-wide uppercase">
					{TYPE_LABEL[qa.type]}
					{qa.project ? ` · ${qa.project}` : ""}
					{qa.style === "shorter" ? " · short" : ""}
				</span>
				<p
					className={`min-w-0 flex-1 ${full ? "" : "line-clamp-2"}`}
					title={qa.question}
				>
					{qa.question}
				</p>
				{qa.screenshots?.map((src, i) => (
					<img
						key={i}
						src={src}
						alt={`Screenshot ${i + 1} sent with this question`}
						title={`Screenshot ${i + 1} sent with this question`}
						className="ov-line h-9 shrink-0 self-start rounded border object-cover"
					/>
				))}
			</div>

			<div className="mt-2.5">
				{qa.status === "thinking" ? (
					<p className="ov-muted animate-pulse">Thinking…</p>
				) : (
					qa.answer && (
						<Markdown text={qa.answer} streaming={qa.status === "streaming"} />
					)
				)}
				{qa.status === "error" && (
					<p
						className={`mt-2 text-[0.85em] ${qa.answer ? "text-warn" : "text-bad"}`}
					>
						{qa.error}
					</p>
				)}
				{qa.status === "done" && qa.truncated && (
					<p className="ov-muted mt-2 text-[0.8em]">
						— cut off at the token limit (raise Max tokens in Settings)
					</p>
				)}
				{qa.status === "done" && qa.servedBy && (
					<p className="ov-muted mt-2 text-right font-mono text-[10px] opacity-70">
						{qa.servedBy}
					</p>
				)}
			</div>
		</article>
	);
}

/** "Status update on…": the projects, best guess first (FR-W6/W9). */
function StatusPick({
	pick,
	index,
	onChoose,
	onClose,
}: {
	pick: WorkPick;
	index: number;
	onChoose: (id: string) => void;
	onClose: () => void;
}) {
	return (
		<section
			className="ov-line mb-3 rounded-lg border p-2"
			aria-label="Pick a project for the status update"
		>
			<div className="flex items-center gap-2 px-1">
				<span className="ov-fg text-[0.85em] font-medium">
					Status update on…
				</span>
				<span className="ov-muted ml-auto text-[10px]">
					↑↓ Enter · 1–9 · Esc
				</span>
				<button
					className="ov-muted ov-btn rounded px-1 text-xs"
					onClick={onClose}
					title="Dismiss (Esc)"
					aria-label="Dismiss"
				>
					✕
				</button>
			</div>
			{pick.question && (
				<p
					className="ov-muted mt-1 line-clamp-2 px-1 text-[0.8em] italic"
					title={pick.question}
				>
					"{pick.question}"
				</p>
			)}
			<ol className="mt-1.5 flex flex-col gap-0.5">
				{pick.projects.slice(0, 9).map((p, i) => (
					<li key={p.id}>
						<button
							onClick={() => onChoose(p.id)}
							className={`ov-btn flex w-full items-center gap-2 rounded px-2 py-1 text-left text-[0.9em] ${i === index ? "ov-tag ov-fg" : ""}`}
						>
							<span className="ov-muted w-3 font-mono text-[10px]">
								{i + 1}
							</span>
							<span className="min-w-0 flex-1 truncate">{p.name}</span>
							{p.id === pick.suggestedId && (
								<span className="ov-muted text-[10px]">best match</span>
							)}
							<span className="ov-muted text-[10px]">
								{PROJECT_STATUS_LABELS[p.status]}
							</span>
						</button>
					</li>
				))}
			</ol>
		</section>
	);
}

function IconButton({
	label,
	disabled,
	pressed,
	onClick,
	children,
}: {
	label: string;
	disabled?: boolean;
	pressed?: boolean;
	onClick: () => void;
	children: string;
}) {
	return (
		<button
			className={`ov-btn rounded px-1.5 text-sm leading-5 disabled:opacity-30 ${pressed ? "ov-fg ov-tag" : "ov-muted"}`}
			onClick={onClick}
			disabled={disabled}
			title={label}
			aria-label={label}
			aria-pressed={pressed}
		>
			{children}
		</button>
	);
}

/** Quitting ends a running session, so it takes a second click within a few seconds. */
function QuitButton() {
	const [armed, setArmed] = useState(false);
	useEffect(() => {
		if (!armed) return;
		const t = setTimeout(() => setArmed(false), 3000);
		return () => clearTimeout(t);
	}, [armed]);
	return (
		<button
			className={`ov-btn rounded px-1.5 text-sm leading-5 ${armed ? "ov-quit-armed" : "ov-muted"}`}
			onClick={() => (armed ? void window.api.ui.quit() : setArmed(true))}
			title={armed ? "Click again to quit Cue" : "Quit Cue (Ctrl+Shift+Q)"}
			aria-label={armed ? "Click again to quit Cue" : "Quit Cue"}
		>
			{armed ? "Quit?" : "⏻"}
		</button>
	);
}

function TextButton({
	label,
	onClick,
	children,
}: {
	label: string;
	onClick: () => void;
	children: string;
}) {
	return (
		<button
			className="ov-muted ov-btn rounded px-1.5 py-0.5 text-[11px]"
			onClick={onClick}
			title={label}
		>
			{children}
		</button>
	);
}
