/**
 * Custom confirmation UI for the permission gate.
 *
 * Shows a select list with an optional note input.
 * Tab switches focus between the list and the note field.
 * Enter confirms the selected action with the note attached.
 *
 * Optionally shows an LLM-generated explanation of the tool call:
 * - Short summary shown by default
 * - Ctrl+E toggles full explanation
 * - Streams in while the user is reading/deciding (zero added latency)
 */

import { DynamicBorder } from "@mariozechner/pi-coding-agent";
import type { Component, KeybindingsManager } from "@mariozechner/pi-tui";
import {
  Container,
  Input,
  matchesKey,
  type SelectItem,
  SelectList,
  Text,
  type Theme,
  type TUI,
} from "@mariozechner/pi-tui";

export interface ConfirmResult {
  choice: string | null;
  note: string;
  /** The explanation result, if available by the time the user decided. */
  explanation: ExplanationResult | null;
  /** Whether the user toggled auto-classify from within the dialog. */
  toggledAutoClassify?: boolean;
}

export type ExplanationVerdict = "safe" | "risky" | "dangerous";

export interface ExplanationResult {
  verdict: ExplanationVerdict;
  short: string;
  detail: string;
}

export interface ExplanationProvider {
  /** Promise that resolves with the parsed explanation. */
  promise: Promise<ExplanationResult | null>;
  /** Abort the in-flight request. */
  abort: () => void;
}

export interface ConfirmUIOptions {
  /** Whether auto-classify is currently enabled. Shown in help text. */
  autoClassify?: boolean;
  /** Whether the explain role is available (controls whether Ctrl+A hint shows). */
  hasExplainRole?: boolean;
}

export function createConfirmUI(
  tui: TUI,
  theme: Theme,
  _kb: KeybindingsManager,
  done: (result: ConfirmResult) => void,
  title: string,
  options: string[],
  explanation?: ExplanationProvider,
  uiOptions?: ConfirmUIOptions,
): Component {
  const blockIndex = options.length - 1; // "Block" is always last
  const container = new Container();
  let focusOnNote = false;
  let explanationState: "loading" | "ready" | "expanded" | "none" = explanation ? "loading" : "none";
  let explanationResult: ExplanationResult | null = null;
  let didToggleAutoClassify = false;

  // Title
  container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
  container.addChild(new Text(theme.fg("accent", title), 1, 0));

  // Explanation text (shown between title and select list)
  const explanationText = new Text("", 1, 0);
  container.addChild(explanationText);

  function updateExplanationDisplay() {
    if (explanationState === "none") {
      explanationText.setText("");
      return;
    }
    if (explanationState === "loading") {
      explanationText.setText(theme.fg("dim", "Explaining..."));
      return;
    }
    if (!explanationResult) return;

    const themeColor =
      explanationResult.verdict === "dangerous"
        ? ("error" as const)
        : explanationResult.verdict === "risky"
          ? ("warning" as const)
          : ("success" as const);
    const tag = explanationResult.verdict.toUpperCase();
    const shortLine = theme.fg(themeColor, `${tag}: ${explanationResult.short}`);

    if (explanationState === "expanded") {
      explanationText.setText(`${shortLine}\n${theme.fg("dim", explanationResult.detail)}`);
    } else {
      const hint = explanationResult.detail ? theme.fg("dim", "  [Ctrl+E]") : "";
      explanationText.setText(`${shortLine}${hint}`);
    }
  }

  // Kick off explanation loading
  if (explanation) {
    updateExplanationDisplay();
    explanation.promise
      .then((result) => {
        if (result) {
          explanationResult = result;
          explanationState = "ready";
          // Default selection based on verdict
          if (result.verdict === "dangerous") {
            selectList.setSelectedIndex(blockIndex);
          }
          // SAFE and RISKY default to index 0 (Allow once), which is already the default
        } else {
          explanationState = "none";
        }
        updateExplanationDisplay();
        updateLabels();
        tui.requestRender();
      })
      .catch(() => {
        explanationState = "none";
        updateExplanationDisplay();
        tui.requestRender();
      });
  }

  // Select list
  const items: SelectItem[] = options.map((opt) => ({ value: opt, label: opt }));
  const selectList = new SelectList(items, Math.min(items.length, 8), {
    selectedPrefix: (t) => theme.fg("accent", t),
    selectedText: (t) => theme.fg("accent", t),
    description: (t) => theme.fg("muted", t),
    scrollInfo: (t) => theme.fg("dim", t),
    noMatch: (t) => theme.fg("warning", t),
  });

  function finish(choice: string | null) {
    explanation?.abort();
    done({
      choice,
      note: noteInput.getValue().trim(),
      explanation: explanationResult,
      toggledAutoClassify: didToggleAutoClassify || undefined,
    });
  }

  selectList.onSelect = (item) => finish(item.value);
  selectList.onCancel = () => finish(null);
  container.addChild(selectList);

  // Note input
  const noteLabel = new Text("", 1, 0);
  container.addChild(noteLabel);

  const noteInput = new Input();
  container.addChild(noteInput);

  // Help
  const helpText = new Text("", 1, 0);
  container.addChild(helpText);
  container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

  function updateLabels() {
    const explainHint = explanationState === "ready" && explanationResult?.detail ? "Ctrl+E detail  |  " : "";
    const currentAuto = (uiOptions?.autoClassify ?? false) !== didToggleAutoClassify;
    const autoHint = uiOptions?.hasExplainRole ? `Ctrl+A auto:${currentAuto ? "on" : "off"}  |  ` : "";
    if (focusOnNote) {
      noteLabel.setText(theme.fg("accent", "Note: "));
      helpText.setText(theme.fg("dim", `${explainHint}${autoHint}Tab list  |  Enter confirm  |  Esc cancel`));
    } else {
      noteLabel.setText(theme.fg("dim", "Note: "));
      helpText.setText(theme.fg("dim", `${explainHint}${autoHint}Tab note  |  Enter confirm  |  Esc cancel`));
    }
  }
  updateLabels();

  return {
    render: (w: number) => container.render(w),
    invalidate: () => container.invalidate(),
    handleInput: (data: string) => {
      // Ctrl+E to toggle detail
      if (matchesKey(data, "ctrl+e") && (explanationState === "ready" || explanationState === "expanded")) {
        explanationState = explanationState === "ready" ? "expanded" : "ready";
        updateExplanationDisplay();
        updateLabels();
        tui.requestRender();
        return;
      }

      // Ctrl+A to toggle auto-classify
      if (matchesKey(data, "ctrl+a") && uiOptions?.hasExplainRole) {
        didToggleAutoClassify = !didToggleAutoClassify;
        updateLabels();
        tui.requestRender();
        return;
      }

      if (matchesKey(data, "tab")) {
        focusOnNote = !focusOnNote;
        updateLabels();
        tui.requestRender();
        return;
      }

      if (focusOnNote) {
        if (matchesKey(data, "return")) {
          const selected = selectList.getSelectedItem();
          if (selected) {
            finish(selected.value);
          }
          return;
        }
        if (matchesKey(data, "escape")) {
          finish(null);
          return;
        }
        noteInput.handleInput(data);
      } else {
        selectList.handleInput(data);
      }
      tui.requestRender();
    },
  };
}
