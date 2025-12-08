# APPlayMIDI - macOS MIDI file player
# https://github.com/benwiggy/applaymidi
{ lib, stdenvNoCC, fetchurl, unzip }:

stdenvNoCC.mkDerivation rec {
  pname = "applaymidi";
  version = "1.12";

  src = fetchurl {
    url = "https://github.com/benwiggy/APPlayMIDI/releases/download/v${version}/APPlayMIDI.app.zip";
    sha256 = "1m4kd1710md97vn0iwlyfz3bfx90pxr4q69dzc4m1qwx0fnbddqq";
  };

  nativeBuildInputs = [ unzip ];

  sourceRoot = ".";

  installPhase = ''
    runHook preInstall
    mkdir -p $out/Applications
    cp -r APPlayMIDI.app $out/Applications/
    runHook postInstall
  '';

  meta = with lib; {
    description = "Lightweight macOS MIDI file player";
    homepage = "https://github.com/benwiggy/applaymidi";
    license = licenses.mit;
    platforms = platforms.darwin;
    maintainers = [ ];
  };
}
