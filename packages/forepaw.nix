# forepaw - desktop automation CLI for AI agents
# Prebuilt binary from GitHub releases.
# https://github.com/aviraccoon/forepaw
{
  lib,
  stdenvNoCC,
  fetchurl,
}:

stdenvNoCC.mkDerivation rec {
  pname = "forepaw-stable";
  version = "0.1.0";

  src = fetchurl {
    url = "https://github.com/aviraccoon/forepaw/releases/download/v${version}/forepaw-darwin-arm64.tar.gz";
    hash = "sha256-kiYtssShr/gQYdZ5IakuTp6nrdR9d4dI07yzZw3FXCQ=";
  };

  sourceRoot = ".";

  installPhase = ''
    runHook preInstall
    mkdir -p $out/bin
    cp forepaw $out/bin/forepaw-stable
    chmod +x $out/bin/forepaw-stable
    runHook postInstall
  '';

  meta = with lib; {
    description = "Desktop automation CLI for AI agents";
    homepage = "https://github.com/aviraccoon/forepaw";
    license = licenses.unlicense;
    platforms = [ "aarch64-darwin" ];
    mainProgram = "forepaw-stable";
  };
}
