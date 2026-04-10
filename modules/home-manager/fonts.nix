# Nerd Fonts for terminal emulators and editors
# All available: nix search nixpkgs 'nerd-fonts'
{ pkgs, ... }:
{
  home.packages = with pkgs; [
    nerd-fonts.jetbrains-mono # Clean, excellent ligatures — safe default
    nerd-fonts.commit-mono # Distinctive, modern
    nerd-fonts.geist-mono # Vercel's font, similar to Inter
    nerd-fonts.iosevka # Narrow, highly customizable
    nerd-fonts.iosevka-term # Iosevka without ligatures
    nerd-fonts.fira-code # Classic, great ligatures
    nerd-fonts.hack # Clean, very readable
    nerd-fonts.monaspace # GitHub's font family
    nerd-fonts.meslo-lg # Patched version of Apple's Menlo
    nerd-fonts.caskaydia-mono # Cascadia Code (Microsoft)
    nerd-fonts.victor-mono # Serif italics for code comments
    nerd-fonts.departure-mono # Pixel-inspired, wide
    nerd-fonts.symbols-only # Just the Nerd Font symbols, pairs with any font
  ];
}
