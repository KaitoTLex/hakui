{
  description = "Hakui offline-first trip bookkeeping";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = { self, nixpkgs }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" ];
      forAllSystems = nixpkgs.lib.genAttrs systems;
      mkPkgs = system: import nixpkgs { inherit system; };
      mkHakui = pkgs:
        let
          lib = pkgs.lib;
          nodejs = pkgs.nodejs_24;
          tesseract = pkgs.tesseract5.override { enableLanguages = [ "eng" "jpn" ]; };
          translationPython = pkgs.python3.withPackages (python: [ python.ctranslate2 python.sentencepiece ]);
          argosArchive = pkgs.fetchurl {
            url = "https://argos-net.com/v1/translate-ja_en-1_1.argosmodel";
            hash = "sha256-Yj40d5WagV6wpe9T4JB5ro8fnTu80jBHO68owD+4MzU=";
          };
          argosModel = pkgs.runCommand "argos-ja-en-1.1" { nativeBuildInputs = [ pkgs.unzip ]; } ''
            mkdir -p $out/packages
            unzip ${argosArchive} -d $out/packages
          '';
          source = lib.cleanSourceWith {
            src = ./.;
            filter = path: type:
              let name = baseNameOf path;
              in !(builtins.elem name [ "node_modules" ".svelte-kit" "build" "data" "result" ]);
          };
        in pkgs.buildNpmPackage {
          pname = "hakui";
          version = "0.1.0";
          src = source;
          inherit nodejs;
          npmDepsHash = "sha256-kRyx/yIxupG3cyIlrhaB2N6O+2qYDQ08UTMcEP2TS4M=";
          nativeBuildInputs = [ pkgs.makeWrapper pkgs.python3 pkgs.pkg-config ];
          buildInputs = [ pkgs.sqlite ];
          npmBuildScript = "build";
          installPhase = ''
            runHook preInstall
            npm prune --omit=dev
            mkdir -p $out/share/hakui $out/bin
            cp -r build node_modules package.json scripts config CurrentFinances.csv $out/share/hakui/
            makeWrapper ${nodejs}/bin/node $out/bin/hakui \
              --add-flags "$out/share/hakui/scripts/start.mjs" \
              --prefix PATH : ${lib.makeBinPath [ pkgs.imagemagick tesseract ]} \
              --set HAKUI_TRANSLATE_COMMAND "$out/bin/hakui-translate"
            makeWrapper ${translationPython}/bin/python3 $out/bin/hakui-translate \
              --add-flags "$out/share/hakui/scripts/translate.py" \
              --set HAKUI_TRANSLATION_MODEL "${argosModel}/packages/ja_en"
            runHook postInstall
          '';
          passthru = { inherit argosModel tesseract; };
          meta = {
            description = "Offline-first trip bookkeeping with local Japanese receipt OCR";
            license = lib.licenses.mit;
            mainProgram = "hakui";
            platforms = systems;
          };
        };
    in {
      packages = forAllSystems (system:
        let pkgs = mkPkgs system; in {
          default = mkHakui pkgs;
          hakui = mkHakui pkgs;
        });

      apps = forAllSystems (system: {
        default = {
          type = "app";
          program = "${self.packages.${system}.default}/bin/hakui";
        };
      });

      devShells = forAllSystems (system:
        let
          pkgs = mkPkgs system;
          tesseract = pkgs.tesseract5.override { enableLanguages = [ "eng" "jpn" ]; };
        in {
          default = pkgs.mkShell {
            packages = [ pkgs.nodejs_24 pkgs.sqlite pkgs.imagemagick tesseract pkgs.python3Packages.ctranslate2 pkgs.python3Packages.sentencepiece ];
            shellHook = ''
              export HAKUI_CONFIG="$PWD/config/hakui.json"
            '';
          };
        });

      checks = forAllSystems (system: { package = self.packages.${system}.default; });
      nixosModules.default = import ./nix/module.nix self;
    };
}
