/**
 * Custom confirmation UI for the permission gate.
 *
 * Shows a select list with an optional note input.
 * Tab switches focus between the list and the note field.
 * Enter confirms the selected action with the note attached.
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
}

export function createConfirmUI(
  tui: TUI,
  theme: Theme,
  _kb: KeybindingsManager,
  done: (result: ConfirmResult) => void,
  title: string,
  options: string[],
): Component {
  const container = new Container();
  let focusOnNote = false;

  // Title
  container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
  container.addChild(new Text(theme.fg("accent", title), 1, 0));

  // Select list
  const items: SelectItem[] = options.map((opt) => ({ value: opt, label: opt }));
  const selectList = new SelectList(items, Math.min(items.length, 8), {
    selectedPrefix: (t) => theme.fg("accent", t),
    selectedText: (t) => theme.fg("accent", t),
    description: (t) => theme.fg("muted", t),
    scrollInfo: (t) => theme.fg("dim", t),
    noMatch: (t) => theme.fg("warning", t),
  });
  selectList.onSelect = (item) => {
    done({ choice: item.value, note: noteInput.getValue().trim() });
  };
  selectList.onCancel = () => {
    done({ choice: null, note: "" });
  };
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
    if (focusOnNote) {
      noteLabel.setText(theme.fg("accent", "Note: "));
      helpText.setText(theme.fg("dim", "Tab list  |  Enter confirm  |  Esc cancel"));
    } else {
      noteLabel.setText(theme.fg("dim", "Note: "));
      helpText.setText(theme.fg("dim", "Tab note  |  Enter confirm  |  Esc cancel"));
    }
  }
  updateLabels();

  return {
    render: (w: number) => container.render(w),
    invalidate: () => container.invalidate(),
    handleInput: (data: string) => {
      if (matchesKey(data, "tab")) {
        focusOnNote = !focusOnNote;
        updateLabels();
        tui.requestRender();
        return;
      }

      if (focusOnNote) {
        if (matchesKey(data, "return")) {
          // Enter in note field = confirm with currently highlighted item
          const selected = selectList.getSelectedItem();
          if (selected) {
            done({ choice: selected.value, note: noteInput.getValue().trim() });
          }
          return;
        }
        if (matchesKey(data, "escape")) {
          done({ choice: null, note: "" });
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
