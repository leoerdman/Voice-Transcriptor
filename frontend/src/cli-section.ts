/**
 * Settings → Command line: what the section shows, decided in one place.
 *
 * The backend owns everything real about command-line access — the
 * token, the connection file, the wrapper script, and the exact command
 * text a user is meant to paste into an agent. `GET /api/cli` returns
 * all of it already composed (`backend/cli_access.py::command_cards`).
 *
 * That is deliberate, and this module exists to keep it that way. If
 * the renderer built the command string itself it would be a SECOND
 * author of the one thing that has to be exactly right: the path to a
 * wrapper the backend wrote, quoted for a shell the backend chose, next
 * to flags the backend's client actually accepts. Those would drift the
 * first time a flag was renamed, and the failure would be a user
 * pasting a command into an agent that answers "unknown option" — with
 * the app itself insisting it is installed.
 *
 * So the renderer's whole job here is presentation, and this module is
 * the pure half of it: take the payload, decide what is on screen, and
 * hand back a view the DOM code writes out verbatim. It parses
 * defensively because the payload crosses a process boundary — a
 * backend mid-upgrade, or a failed request handled as an empty object,
 * must render as "off", never as a half-populated section offering a
 * command path that is an empty string.
 */

export interface CliCard {
  id: string;
  title: string;
  text: string;
  note: string;
}

export interface CliDefaults {
  engine: string;
  model: string;
  language: string;
  diarize: boolean;
  engines: string[];
  localModels: string[];
}

export interface CliAccessStatus {
  enabled: boolean;
  baseUrl: string;
  commandPath: string;
  cliDir: string;
  cards: CliCard[];
  defaults: CliDefaults;
}

export interface CliSectionView {
  /** Whether the switch reads on. */
  enabled: boolean;
  /** The one line under the heading. */
  summary: string;
  /** Cards to render, empty while off. */
  cards: CliCard[];
  /** Whether the card list occupies space at all. */
  showCards: boolean;
}

const EMPTY_DEFAULTS: CliDefaults = {
  engine: "",
  model: "",
  language: "",
  diarize: false,
  engines: [],
  localModels: [],
};

export const CLI_ACCESS_OFF: CliAccessStatus = {
  enabled: false,
  baseUrl: "",
  commandPath: "",
  cliDir: "",
  cards: [],
  defaults: EMPTY_DEFAULTS,
};

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function textList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => text(entry)).filter((entry) => entry.length > 0);
}

function normalizeCard(raw: unknown): CliCard | null {
  if (!raw || typeof raw !== "object") return null;
  const source = raw as Record<string, unknown>;
  const body = text(source.text);
  // A card with no command in it is not a card. Rendering one would
  // give the user a Copy button that copies nothing.
  if (!body) return null;
  return {
    id: text(source.id) || body.slice(0, 24),
    title: text(source.title) || "Command",
    text: body,
    note: text(source.note),
  };
}

function normalizeDefaults(raw: unknown): CliDefaults {
  if (!raw || typeof raw !== "object") return EMPTY_DEFAULTS;
  const source = raw as Record<string, unknown>;
  return {
    engine: text(source.engine),
    model: text(source.model),
    language: text(source.language),
    diarize: source.diarize === true,
    engines: textList(source.engines),
    localModels: textList(source.local_models),
  };
}

/**
 * The payload as this section may trust it.
 *
 * "Enabled" requires a command path as well as the flag: the two come
 * from the same backend object, but the flag alone is what the section
 * would key its whole layout off, and an on-state with no path to show
 * is the one combination that renders as a working install the user
 * cannot use.
 */
export function normalizeCliStatus(payload: unknown): CliAccessStatus {
  if (!payload || typeof payload !== "object") return CLI_ACCESS_OFF;
  const source = payload as Record<string, unknown>;
  const commandPath = text(source.command_path);
  const enabled = source.enabled === true && commandPath.length > 0;
  return {
    enabled,
    baseUrl: text(source.base_url),
    commandPath,
    cliDir: text(source.cli_dir),
    cards: enabled
      ? (Array.isArray(source.cards) ? source.cards : [])
          .map(normalizeCard)
          .filter((card): card is CliCard => card !== null)
      : [],
    defaults: normalizeDefaults(source.defaults),
  };
}

/** How the CLI would transcribe right now, in the words the app uses. */
export function cliDefaultsSummary(defaults: CliDefaults): string {
  const engine = defaults.engine || "local";
  const parts = [defaults.model ? `${engine}/${defaults.model}` : engine];
  parts.push(defaults.language || "auto");
  if (defaults.diarize) parts.push("speakers");
  return parts.join(" · ");
}

export function cliSectionView(status: CliAccessStatus): CliSectionView {
  if (!status.enabled) {
    return {
      enabled: false,
      summary:
        "Off. Switch on to let scripts, terminals and agents transcribe " +
        "through this app — the same engines and models it uses itself.",
      cards: [],
      showCards: false,
    };
  }
  const where = status.baseUrl ? ` at ${status.baseUrl}` : "";
  return {
    enabled: true,
    summary:
      `On${where}. A command with no options transcribes with ` +
      `${cliDefaultsSummary(status.defaults)} — whatever the Upload tab is set to.`,
    cards: status.cards,
    showCards: status.cards.length > 0,
  };
}
