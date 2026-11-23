/**
 * "Describe a finish…" (feature-flagged, flag.ts): type a description, a model writes the design, the
 * studio validates it (and compiles any custom WGSL on the card engine's GPU), retries once with the
 * problems listed, and applies it as one undoable step. Loaded lazily when the dialog first opens.
 *
 * With no provider configured it says how to get the same result today: the `/describe-finish` skill
 * in Claude Code (no key), or the user's own API key.
 */
import type { CardDesign } from "@card3d/core/model";
import { MAX_FINISH_DESCRIPTION } from "@card3d/core/describe";
import { button, createDialog } from "../ui/dialog.ts";
import { h } from "../ui/dom.ts";
import { EXAMPLE_DESCRIPTION as EXAMPLE, describeFinish, mergeUploads, skillCommand, validateFinish } from "./flow.ts";
import { clearApiKey, configuredProvider, loadApiKey, looksLikeApiKey, saveApiKey, type FinishProvider } from "./providers.ts";

export interface DescribeDialogDeps {
  getDesign(): CardDesign;
  /** Compiles custom WGSL on the live card's GPU (`EngineStage.checkShader`); null when it can't now. */
  check(code: string): Promise<{ line: number; message: string }[] | null>;
  /** Apply the design as one undo step. */
  apply(next: CardDesign, label: string): void;
}

export class DescribeDialog {
  private readonly shell = createDialog("Describe a finish", { wide: true, className: "c3-describe" });
  private readonly area: HTMLTextAreaElement;
  private readonly providerEl = h("div.c3-describe-provider");
  private readonly status = h("p.c3-muted", { role: "status" });
  private readonly error = h("p.c3-error", { role: "alert" });
  private readonly go: HTMLButtonElement;
  private provider: FinishProvider | null = null;
  private running: AbortController | null = null;
  private cmd: HTMLElement | null = null;

  constructor(private readonly deps: DescribeDialogDeps) {
    this.area = h("textarea.c3-textarea c3-describe-text", {
      rows: 3,
      maxlength: MAX_FINISH_DESCRIPTION,
      placeholder: `e.g. ${EXAMPLE}`,
      "aria-label": "Describe the finish",
      spellcheck: "true",
    });
    this.shell.body.append(
      h("p.c3-muted", {
        text: "Describe the metal, texture, colour, foil or effect in your own words. The result replaces the finish (your name, artwork and stickers stay) and can be undone.",
      }),
      this.area,
      this.providerEl,
      this.status,
      this.error,
    );
    this.go = button("Describe", () => void this.submit(), "primary");
    this.shell.footer.append(
      h("span.c3-grow"),
      button("Close", () => this.shell.close()),
      this.go,
    );
    this.area.addEventListener("input", () => this.sync());
    this.area.addEventListener("keydown", (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") void this.submit();
    });
    this.shell.dialog.addEventListener("close", () => this.running?.abort());
  }

  async open(): Promise<void> {
    this.error.textContent = "";
    this.status.textContent = "";
    await this.refreshProvider();
    this.shell.open();
    this.area.focus();
  }

  private async refreshProvider(): Promise<void> {
    this.provider = await configuredProvider();
    this.renderProvider();
    this.sync();
  }

  private sync(): void {
    this.go.disabled = !this.provider || !this.area.value.trim() || !!this.running;
    if (this.cmd) this.cmd.textContent = skillCommand(this.area.value);
  }

  /** The provider line, or (none configured) the Claude Code command and the key form. */
  private renderProvider(): void {
    this.providerEl.replaceChildren();
    const key = loadApiKey();
    this.cmd = h("code.c3-describe-cmd", { "data-testid": "describe-skill-command" });
    const copy = button(
      "Copy",
      async () => {
        try {
          await navigator.clipboard.writeText(this.cmd!.textContent ?? "");
          copy.textContent = "Copied";
        } catch {
          copy.textContent = "Select and copy";
        }
        setTimeout(() => (copy.textContent = "Copy"), 1400);
      },
      "ghost",
    );
    const skill = h(
      "div.c3-describe-skill",
      {},
      h("p.c3-muted", { html: "<strong>No key needed with Claude Code:</strong> in a clone of this repo, run" }),
      h("div.c3-describe-cmdrow", {}, this.cmd, copy),
      h("p.c3-muted", { text: "It writes the design, renders previews to check it and gives you a link that opens here." }),
    );
    if (this.provider) {
      const using = h("p.c3-muted", { "data-testid": "describe-provider" }, `Using ${this.provider.label}.`);
      if (key) {
        const remove = h("button.c3-linkbtn", { type: "button", text: "Remove key" });
        remove.addEventListener("click", () => {
          clearApiKey();
          void this.refreshProvider();
        });
        using.append(" ", remove);
      }
      this.providerEl.append(using);
      if (!key) this.providerEl.append(this.keyForm(true));
      return;
    }
    this.providerEl.append(
      h("p.c3-note", { "data-testid": "describe-unconfigured", text: "No model is set up for this studio yet." }),
      skill,
      this.keyForm(false),
    );
    this.sync();
  }

  /** "Use your own Anthropic API key": masked input, kept only in this browser. */
  private keyForm(collapsed: boolean): HTMLElement {
    const input = h("input.c3-input c3-describe-key", {
      type: "password",
      autocomplete: "off",
      spellcheck: "false",
      placeholder: "sk-ant-…",
      "aria-label": "Anthropic API key",
    });
    const msg = h("p.c3-error");
    const save = button("Save key", () => {
      const k = input.value.trim();
      if (!looksLikeApiKey(k)) {
        msg.textContent = "That doesn't look like an Anthropic API key (sk-ant-…).";
        return;
      }
      if (!saveApiKey(k)) {
        msg.textContent = "This browser won't store it (private mode?).";
        return;
      }
      input.value = "";
      void this.refreshProvider();
    });
    const body = h(
      "div.c3-describe-keyform",
      {},
      h("p.c3-muted", {
        text: "Or use your own Anthropic API key. It stays in this browser (localStorage): never in links, designs or exports. Requests go straight from this page to api.anthropic.com and are billed to your key.",
      }),
      h("div.c3-describe-cmdrow", {}, input, save),
      msg,
    );
    if (!collapsed) return body;
    return h("details.c3-describe-keydetails", {}, h("summary", { text: "Use your own API key instead" }), body);
  }

  private async submit(): Promise<void> {
    const description = this.area.value.trim();
    if (!description || !this.provider || this.running) return;
    const ctrl = new AbortController();
    this.running = ctrl;
    this.error.textContent = "";
    this.sync();
    this.go.textContent = "Designing…";
    const current = this.deps.getDesign();
    try {
      const result = await describeFinish({
        provider: this.provider,
        description,
        current: { cardholderName: current.cardholderName, cardholderBio: current.cardholderBio },
        validate: (raw) => validateFinish(raw, (code) => this.deps.check(code)),
        signal: ctrl.signal,
        onAttempt: (n, of) =>
          (this.status.textContent = n === 1 ? "Designing… (this can take a minute)" : `Fixing validation problems (attempt ${n} of ${of})…`),
      });
      if (ctrl.signal.aborted) return;
      const label = `Describe: ${description.length > 40 ? `${description.slice(0, 39)}…` : description}`;
      this.deps.apply(mergeUploads(result.design, this.deps.getDesign()), label);
      this.status.textContent = `${result.summary || "Applied."} Undo to go back.`;
      if (result.warnings.length) console.info("[describe] warnings:", result.warnings);
    } catch (err) {
      if ((err as Error).name === "AbortError") {
        this.status.textContent = "Cancelled.";
      } else {
        this.status.textContent = "";
        this.error.textContent = (err as Error).message;
      }
    } finally {
      this.running = null;
      this.go.textContent = "Describe";
      this.sync();
    }
  }
}
