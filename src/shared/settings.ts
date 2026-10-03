import { z } from "zod";

/** Window bounds persisted for the overlay (FR-O1). */
const BoundsSchema = z.object({
	x: z.number().int(),
	y: z.number().int(),
	width: z.number().int().min(200),
	height: z.number().int().min(120),
});

const HotkeysSchema = z.object({
	startStop: z.string().default("CommandOrControl+Shift+Enter"),
	answerNow: z.string().default("CommandOrControl+Shift+Space"),
	screenshot: z.string().default("CommandOrControl+Shift+S"),
	/** Add a screenshot to the next answer without answering yet (long, scrolled questions). */
	addScreenshot: z.string().default("CommandOrControl+Shift+Alt+S"),
	regenerate: z.string().default("CommandOrControl+Shift+R"),
	shorter: z.string().default("CommandOrControl+Shift+D"),
	toggleOverlay: z.string().default("CommandOrControl+Shift+H"),
	toggleMain: z.string().default("CommandOrControl+Shift+O"),
	quitApp: z.string().default("CommandOrControl+Shift+Q"),
	prevAnswer: z.string().default("CommandOrControl+Shift+Left"),
	nextAnswer: z.string().default("CommandOrControl+Shift+Right"),
	toggleAutoAnswer: z.string().default("CommandOrControl+Shift+A"),
	toggleVoiceAsk: z.string().default("CommandOrControl+Shift+M"),
	focusAsk: z.string().default("CommandOrControl+Shift+K"),
});

/** Work Mode: project status updates on calls. Interview Mode: interview answers and Practice (FR-MD1). */
export const APP_MODES = ["work", "interview"] as const;
export type AppMode = (typeof APP_MODES)[number];
export const APP_MODE_LABELS: Record<AppMode, string> = {
	work: "Work",
	interview: "Interview",
};

export const STT_PROVIDERS = ["deepgram", "assemblyai"] as const;
export type SttProviderId = (typeof STT_PROVIDERS)[number];
export const STT_PROVIDER_LABELS: Record<SttProviderId, string> = {
	deepgram: "Deepgram",
	assemblyai: "AssemblyAI",
};

export const LLM_PROVIDERS = [
	"anthropic",
	"openrouter",
	"groq",
	"gemini",
] as const;
export type LlmProviderId = (typeof LLM_PROVIDERS)[number];
/** Providers spoken to over the OpenAI-compatible chat completions API. */
export type CompatProviderId = Exclude<LlmProviderId, "anthropic">;

/** Hard cap on screenshots per question (each image adds input tokens and latency). */
export const MAX_SCREENSHOTS = 10;
/** Groq's vision model accepts at most this many images per request. */
export const GROQ_MAX_IMAGES = 3;

/** A model field lists up to this many IDs (comma or newline separated), tried in order. */
export const MAX_MODEL_CHAIN = 12;

/**
 * One-click OpenRouter model chains. `free` costs nothing but is capped at 20 requests/min and
 * 50/day without purchased credits; its upstreams share quota with every free user, so the chain
 * spreads across many different upstreams, ending with OpenRouter's own free router. Free
 * endpoints may log or train on prompts.
 */
export const OPENROUTER_PRESETS = {
	free: {
		label: "Free (testing)",
		answerModel: [
			"google/gemma-4-31b-it:free",
			"nvidia/nemotron-3-super-120b-a12b:free",
			"qwen/qwen3.8-27b:free",
			"cohere/north-mini-code:free",
			"thinkingmachines/inkling:free",
			"poolside/laguna-s-2.1:free",
			"nvidia/nemotron-3-ultra-550b-a55b:free",
			"google/gemma-4-26b-a4b-it:free",
			"thinkingmachines/inkling-small:free",
			"inclusionai/ling-3.0-flash-sante:free",
			"poolside/laguna-xs-2.1:free",
			"openrouter/free",
		].join(", "),
		fastModel: [
			"google/gemma-4-26b-a4b-it:free",
			"nvidia/nemotron-3.5-lightning:free",
			"thinkingmachines/inkling-small:free",
			"poolside/laguna-xs-2.1:free",
			"liquid/lfm-2.5-2.6b:free",
			"qwen/qwen3.8-27b:free",
			"cohere/north-mini-code:free",
			"inclusionai/ling-3.0-flash-sante:free",
			"nvidia/nemotron-3-super-120b-a12b:free",
			"openrouter/free",
		].join(", "),
		// Free models that accept images (screenshots).
		visionModel: [
			"qwen/qwen3.8-27b:free",
			"google/gemma-4-31b-it:free",
			"thinkingmachines/inkling:free",
			"google/gemma-4-26b-a4b-it:free",
			"thinkingmachines/inkling-small:free",
			"openrouter/free",
		].join(", "),
	},
	/**
	 * Pay-as-you-go with purchased credits: cheap, fast models with no shared free-pool limits.
	 * `:nitro` routes to the model's highest-throughput host. Screenshots: Qwen 3.8 (the model
	 * Groq's free tier uses) → Gemini 3.1 Flash-Lite → Llama 4 Scout, about $0.001–0.005 each.
	 */
	paid: {
		label: "Paid (fast)",
		answerModel:
			"openai/gpt-oss-120b:nitro, google/gemini-3.1-flash-lite, anthropic/claude-haiku-4.5",
		fastModel: "openai/gpt-oss-20b:nitro, google/gemini-3.1-flash-lite",
		visionModel:
			"qwen/qwen3.8-27b:nitro, google/gemini-3.1-flash-lite, meta-llama/llama-4-scout",
	},
	claude: {
		label: "Claude",
		answerModel: "anthropic/claude-sonnet-5.5",
		fastModel: "anthropic/claude-haiku-4.5",
		visionModel: "anthropic/claude-sonnet-5.5",
	},
} as const;

/** Free-tier defaults; each model has its own daily quota, so a chain also outlasts one model's cap. */
const GROQ_DEFAULTS = {
	answerModel: "openai/gpt-oss-120b, qwen/qwen3.8-27b, openai/gpt-oss-20b",
	fastModel: "openai/gpt-oss-20b, qwen/qwen3.8-27b, openai/gpt-oss-120b",
	// Groq's only model that accepts images.
	visionModel: "qwen/qwen3.8-27b",
};
const GEMINI_DEFAULTS = {
	answerModel:
		"gemini-3.8-flash, gemini-3.7-flash, gemini-3.5-flash, gemini-3.1-flash-lite",
	fastModel: "gemini-3.1-flash-lite, gemini-3.5-flash-lite, gemini-3.5-flash",
	visionModel: "gemini-3.8-flash, gemini-3.7-flash, gemini-3.5-flash",
};

/**
 * Reasoning effort. OpenRouter: unified `reasoning.effort`; Groq / Gemini: `reasoning_effort`.
 * `default` sends nothing and keeps the model's default.
 */
export const REASONING_EFFORTS = [
	"default",
	"none",
	"minimal",
	"low",
	"medium",
	"high",
] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

type ModelDefaults = {
	answerModel: string;
	fastModel: string;
	visionModel: string;
};

const compatProvider = (
	defaults: ModelDefaults,
	reasoningEffort: ReasoningEffort,
) =>
	z
		.object({
			answerModel: z.string().min(1).default(defaults.answerModel),
			fastModel: z.string().min(1).default(defaults.fastModel),
			/** Models that accept images, for screenshots. Empty: this provider is skipped for them. */
			visionModel: z.string().default(defaults.visionModel),
			reasoningEffort: z.enum(REASONING_EFFORTS).default(reasoningEffort),
		})
		.prefault({});

// `prefault({})` parses the empty object so nested field defaults are applied.
/** Deepgram streaming regions. Some networks reach one far more reliably than the other. */
export const DEEPGRAM_REGIONS = ["us", "eu"] as const;
export type DeepgramRegion = (typeof DEEPGRAM_REGIONS)[number];
export const DEEPGRAM_REGION_LABELS: Record<DeepgramRegion, string> = {
	us: "US (api.deepgram.com)",
	eu: "EU (api.eu.deepgram.com)",
};

export const SettingsSchema = z.object({
	/** Chosen on the Session tab before a session starts; locked while one runs. */
	mode: z.enum(APP_MODES).default("work"),
	stt: z
		.object({
			provider: z.enum(STT_PROVIDERS).default("deepgram"),
			/** Deepgram model. */
			model: z.string().min(1).default("nova-3"),
			/** Deepgram endpoint region. */
			deepgramRegion: z.enum(DEEPGRAM_REGIONS).default("us"),
			/** AssemblyAI streaming model (`universal-streaming-english` is the cheapest and fastest). */
			assemblyaiModel: z.string().min(1).default("universal-streaming-english"),
			language: z.string().min(1).default("en"),
			endpointingMs: z.number().int().min(10).max(5000).default(300),
			utteranceEndMs: z.number().int().min(1000).max(5000).default(1000),
		})
		.prefault({}),
	llm: z
		.object({
			// Groq: free tier with 1,000 requests/day per model and fast responses; free OpenRouter models are much slower.
			provider: z.enum(LLM_PROVIDERS).default("groq"),
			// Anthropic model IDs (kept at this level for settings saved before OpenRouter support).
			answerModel: z.string().min(1).default("claude-sonnet-5-5"),
			fastModel: z.string().min(1).default("claude-haiku-4-5-20251001"),
			visionModel: z.string().default("claude-sonnet-5-5"),
			/** Tried in order when the primary provider fails or runs out (only those with an API key). */
			fallbackProviders: z
				.array(z.enum(LLM_PROVIDERS))
				.max(LLM_PROVIDERS.length)
				.default(["openrouter", "gemini"]),
			/**
			 * Which provider screenshots try first. `auto`: the main provider, then the backups. A provider
			 * (e.g. paid OpenRouter) goes first and the rest follow in the usual order.
			 */
			visionProvider: z.enum(["auto", ...LLM_PROVIDERS]).default("auto"),
			/** OpenRouter: effort applies to answers only (sending it to Haiku-class models would turn thinking on). */
			openrouter: compatProvider(OPENROUTER_PRESETS.free, "low"),
			/** gpt-oss can't turn reasoning off; `low` keeps it short. */
			groq: compatProvider(GROQ_DEFAULTS, "low"),
			/** Gemini 3 can't turn thinking off; `minimal` is the fastest setting. */
			gemini: compatProvider(GEMINI_DEFAULTS, "minimal"),
			maxTokens: z.number().int().min(50).max(8000).default(600),
			/** Coding, system design and screenshots. Room for the three step-by-step versions. */
			maxTokensCoding: z.number().int().min(50).max(16000).default(3000),
			/**
			 * `stepwise`: coding answers come as three versions — pseudocode, a brute-force solution
			 * (with its poor complexity), then the optimal solution. `direct`: approach + optimal code only.
			 */
			codingAnswer: z.enum(["stepwise", "direct"]).default("stepwise"),
		})
		.prefault({}),
	audio: z
		.object({
			micEnabled: z.boolean().default(false),
			micDeviceId: z.string().nullable().default(null),
		})
		.prefault({}),
	detection: z
		.object({
			autoAnswer: z.boolean().default(true),
			minWords: z.number().int().min(1).max(50).default(6),
			debounceMs: z.number().int().min(0).max(10000).default(2000),
			/** After a pause mid-sentence (no closing punctuation, or a hanging word), wait this long for the speaker to go on. 0 = off. */
			pauseGraceMs: z.number().int().min(0).max(5000).default(1500),
		})
		.prefault({}),
	screen: z
		.object({
			/** Attach a fresh screenshot to every answer (coding rounds). */
			alwaysInclude: z.boolean().default(false),
			/** Electron display id as a string; null = primary display. */
			displayId: z.string().nullable().default(null),
			maxEdgePx: z.number().int().min(400).max(4000).default(1600),
			/** Screenshots per question (scrolled, long problems). Groq takes at most 3 and is skipped above that. */
			maxScreenshots: z.number().int().min(1).max(MAX_SCREENSHOTS).default(5),
		})
		.prefault({}),
	overlay: z
		.object({
			opacity: z.number().min(0.4).max(1).default(0.9),
			fontSize: z.number().int().min(12).max(22).default(15),
			theme: z.enum(["dark", "light"]).default("dark"),
			/** `single`: one Q&A at a time with prev/next. `list`: every Q&A of the session in one scroll. */
			view: z.enum(["single", "list"]).default("single"),
			bounds: BoundsSchema.nullable().default(null),
		})
		.prefault({}),
	/** At 80% of the cap a warning shows; at 100% answers switch to the fast models. 0 = no cap. */
	cost: z
		.object({ sessionCapUsd: z.number().min(0).max(1000).default(5) })
		.prefault({}),
	hotkeys: HotkeysSchema.prefault({}),
	/** Practice Mode (FR-P1..P4); round and count are remembered from the last run. */
	practice: z
		.object({
			round: z
				.enum(["behavioral", "technical", "system_design", "mixed"])
				.default("mixed"),
			count: z.union([z.literal(5), z.literal(10), z.literal(15)]).default(5),
			/** Read questions aloud (Web Speech API). */
			speak: z.boolean().default(true),
			/** speechSynthesis voice name; null = system default. */
			voice: z.string().nullable().default(null),
			rate: z.number().min(0.5).max(2).default(1),
			/** Start recording once the question has been read. */
			autoRecord: z.boolean().default(true),
		})
		.prefault({}),
	/** Work Mode: Teams sync (FR-T3). Sign-in tokens are secrets, never stored here. */
	work: z
		.object({
			teams: z
				.object({
					/** Application (client) ID of the user's Entra app registration (public client, device-code sign-in). */
					clientId: z.string().trim().max(100).default(""),
					/** Directory (tenant) ID or domain; `organizations` = any work or school account. */
					tenant: z.string().trim().min(1).max(200).default("organizations"),
					/** Microsoft identity platform; the local mock (npm run mock-teams) for testing. */
					authorityUrl: z
						.string()
						.url()
						.default("https://login.microsoftonline.com"),
					graphBaseUrl: z.string().url().default("https://graph.microsoft.com"),
					/** Chats and channels followed for updates. */
					sources: z
						.array(
							z.object({
								kind: z.enum(["chat", "channel"]),
								id: z.string().min(1).max(300),
								/** The team a channel belongs to. */
								teamId: z.string().max(300).nullable().default(null),
								name: z.string().max(300).default(""),
							}),
						)
						.max(20)
						.default([]),
					pollMinutes: z.number().int().min(1).max(60).default(5),
					/** Also read team channels. Needs ChannelMessage.Read.All, which an admin must approve; chats need only Chat.Read. */
					includeChannels: z.boolean().default(false),
					/** Polling on/off (keeps the sign-in). */
					enabled: z.boolean().default(true),
				})
				.prefault({}),
		})
		.prefault({}),
	preferredLanguage: z.string().min(1).default("TypeScript"),
	/** Save screenshots with the session history (off: they are only kept in memory). */
	keepScreenshots: z.boolean().default(false),
});

export type Settings = z.infer<typeof SettingsSchema>;
export type HotkeyAction = keyof Settings["hotkeys"];

export const DEFAULT_SETTINGS: Settings = SettingsSchema.parse({});

export type DeepPartial<T> = {
	[K in keyof T]?: T[K] extends object | null
		? T[K] extends unknown[] | null
			? T[K]
			: DeepPartial<T[K]>
		: T[K];
};

export const API_KEY_PROVIDERS = [
	"deepgram",
	"assemblyai",
	"anthropic",
	"openrouter",
	"groq",
	"gemini",
] as const;
export type ApiKeyProvider = (typeof API_KEY_PROVIDERS)[number];

/** What renderers see about API keys: presence only, never the value. */
export type ApiKeyStatus = Record<ApiKeyProvider, boolean>;

/** OpenRouter free presets from earlier versions; saved settings still holding one are upgraded. */
const LEGACY_FREE_PRESETS = [
	{
		answerModel: "google/gemma-4-31b-it:free",
		fastModel: "google/gemma-4-26b-a4b-it:free",
	},
	{
		answerModel:
			"google/gemma-4-31b-it:free, nvidia/nemotron-3-super-120b-a12b:free, openrouter/free",
		fastModel:
			"google/gemma-4-26b-a4b-it:free, nvidia/nemotron-3.5-lightning:free, openrouter/free",
	},
];

/** Coding token budget before step-by-step coding answers needed more room. */
const LEGACY_MAX_TOKENS_CODING = 1500;
/** First add-screenshot default; another common app (screen recorders, IDEs) often owns it. */
const LEGACY_ADD_SCREENSHOT = "CommandOrControl+Alt+S";

/**
 * Settings saved before modes existed belong to someone already using Interview Mode, so they
 * keep it; only fresh installs start in Work Mode. Applied to the raw JSON before parsing.
 */
export function applyLegacyMode(raw: unknown): unknown {
	if (!isPlainObject(raw) || "mode" in raw) return raw;
	return { ...raw, mode: "interview" };
}

/** Returns upgraded settings, or null when nothing needed changing. */
export function upgradeSettings(settings: Settings): Settings | null {
	let next = settings;
	const or = next.llm.openrouter;
	if (
		LEGACY_FREE_PRESETS.some(
			(p) => p.answerModel === or.answerModel && p.fastModel === or.fastModel,
		)
	) {
		const { answerModel, fastModel } = OPENROUTER_PRESETS.free;
		next = {
			...next,
			llm: { ...next.llm, openrouter: { ...or, answerModel, fastModel } },
		};
	}
	// The old default would cut off the third (optimal) version of a step-by-step coding answer.
	if (next.llm.maxTokensCoding === LEGACY_MAX_TOKENS_CODING) {
		next = {
			...next,
			llm: {
				...next.llm,
				maxTokensCoding: DEFAULT_SETTINGS.llm.maxTokensCoding,
			},
		};
	}
	if (next.hotkeys.addScreenshot === LEGACY_ADD_SCREENSHOT) {
		next = {
			...next,
			hotkeys: {
				...next.hotkeys,
				addScreenshot: DEFAULT_SETTINGS.hotkeys.addScreenshot,
			},
		};
	}
	return next === settings ? null : next;
}

/** `vision`: requests carrying a screenshot. */
export type ModelRole = "answer" | "fast" | "vision";

export type ModelChains = ModelDefaults;

/** Answer/fast/vision model chains configured for one provider. */
export function modelsFor(
	settings: Settings,
	provider: LlmProviderId,
): ModelChains {
	const { answerModel, fastModel, visionModel } =
		provider === "anthropic" ? settings.llm : settings.llm[provider];
	return { answerModel, fastModel, visionModel };
}

/** The chain for one role. */
export function modelFor(
	settings: Settings,
	provider: LlmProviderId,
	role: ModelRole,
): string {
	const m = modelsFor(settings, provider);
	return role === "fast"
		? m.fastModel
		: role === "vision"
			? m.visionModel
			: m.answerModel;
}

/** The STT model for the selected provider. */
export function sttModel(settings: Settings): string {
	return settings.stt.provider === "assemblyai"
		? settings.stt.assemblyaiModel
		: settings.stt.model;
}

/** Model chains for the primary LLM provider. */
export function activeModels(settings: Settings): ModelChains {
	return modelsFor(settings, settings.llm.provider);
}

/**
 * Primary provider, then the selected fallbacks, without duplicates. For screenshots, the chosen
 * screenshot provider goes first (it must have a key to be used, like any other).
 */
export function providerOrder(
	settings: Settings,
	role?: ModelRole,
): LlmProviderId[] {
	const order = [settings.llm.provider, ...settings.llm.fallbackProviders];
	const vision = settings.llm.visionProvider;
	if (role === "vision" && vision !== "auto") order.unshift(vision);
	return [...new Set(order)];
}

/** Split a model field into its IDs ("a, b" or one per line), capped at MAX_MODEL_CHAIN. */
export function splitModels(field: string): string[] {
	return field
		.split(/[,\n]/)
		.map((m) => m.trim())
		.filter(Boolean)
		.slice(0, MAX_MODEL_CHAIN);
}

export const LLM_PROVIDER_LABELS: Record<LlmProviderId, string> = {
	anthropic: "Anthropic",
	openrouter: "OpenRouter",
	groq: "Groq",
	gemini: "Google Gemini",
};

function isPlainObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Deep-merge a partial patch into settings, then re-validate. Throws on invalid values. */
export function mergeSettings(base: Settings, patch: unknown): Settings {
	const merge = (a: unknown, b: unknown): unknown => {
		if (!isPlainObject(a) || !isPlainObject(b)) return b === undefined ? a : b;
		const out: Record<string, unknown> = { ...a };
		for (const [k, v] of Object.entries(b)) out[k] = merge(a[k], v);
		return out;
	};
	return SettingsSchema.parse(merge(base, patch));
}
