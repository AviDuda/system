# vkQuake - Vulkan Quake engine (QuakeSpasm fork)
# https://github.com/Novum/vkQuake
# Signed and notarized macOS build from Mac Source Ports
{
  lib,
  stdenvNoCC,
  fetchurl,
}:

stdenvNoCC.mkDerivation rec {
  pname = "vkquake";
  version = "1.34.0";

  src = fetchurl {
    url = "https://github.com/MacSourcePorts/MSPBuildSystem/releases/download/vkQuake_${version}/vkQuake-${version}.dmg";
    sha256 = "074byzig16g76a2vh77kdr20plh1ynyk3750qv0wak2wsvj23qs2";
  };

  dontUnpack = true;

  installPhase = ''
    runHook preInstall
    mkdir -p $out/Applications
    /usr/bin/hdiutil attach "$src" -nobrowse -readonly -mountpoint mnt
    cp -r mnt/vkQuake.app $out/Applications/
    /usr/bin/hdiutil detach mnt
    runHook postInstall
  '';

  meta = with lib; {
    description = "Vulkan Quake engine (QuakeSpasm fork)";
    homepage = "https://github.com/Novum/vkQuake";
    license = licenses.gpl2Only;
    platforms = platforms.darwin;
    maintainers = [ ];
  };
}
