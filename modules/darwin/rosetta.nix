# Rosetta 2: x86_64 emulation on Apple Silicon
{ ... }: {
  system.activationScripts.rosetta = {
    enable = true;
    text = ''
      /usr/sbin/softwareupdate --install-rosetta --agree-to-license
    '';
  };
}
