# tmux configuration
# Pi requires extended-keys for Shift+Enter and modified key support
# See: https://pi.dev/docs/latest/tmux
{
  programs.tmux = {
    enable = true;
    mouse = true;
    escapeTime = 0;
    historyLimit = 50000;
    terminal = "screen-256color";
    baseIndex = 1;
    focusEvents = true;
    extraConfig = ''
      # Pi coding agent: extended key reporting for Shift+Enter, Ctrl+Enter, etc.
      set -g extended-keys on
      set -g extended-keys-format csi-u

      # Renumber windows sequentially when one is closed
      setw -g renumber-windows on

      # Show tmux messages for 4 seconds (default 750ms is too fast)
      set -g display-time 4000

      # True color passthrough for terminals that support it
      set -as terminal-features ",xterm-256color:RGB"

      # iTerm2 integration: allow shell integration passthrough (tmux 3.3+)
      set-option -g allow-passthrough on

      # Show tmux window titles as iTerm2 tab titles
      set-option -g set-titles on
      set-option -g set-titles-string '#T'

      # Intuitive split keys that preserve current working directory
      bind | split-window -h -c "#{pane_current_path}"
      bind - split-window -v -c "#{pane_current_path}"
      bind c new-window -c "#{pane_current_path}"
    '';
  };
}
