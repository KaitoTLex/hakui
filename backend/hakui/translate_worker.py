from __future__ import annotations

import os
import sys
from pathlib import Path

import ctranslate2
import sentencepiece


def main() -> None:
    model_dir = Path(os.environ["HAKUI_TRANSLATION_MODEL"])
    processor = sentencepiece.SentencePieceProcessor(model_file=str(model_dir / "sentencepiece.model"))
    translator = ctranslate2.Translator(str(model_dir / "model"), device="cpu", inter_threads=1, intra_threads=1)
    lines = sys.stdin.read().splitlines()
    tokenized = [processor.encode(line, out_type=str) for line in lines]
    results = translator.translate_batch(tokenized, beam_size=2)
    sys.stdout.write("\n".join(processor.decode(result.hypotheses[0]) for result in results))


if __name__ == "__main__":
    main()
