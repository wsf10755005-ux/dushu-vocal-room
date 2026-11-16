Local OCR runtime for numbered musical notation.

tesseract.esm.min.js and worker.min.js: Tesseract.js 7.0.0
Source: https://github.com/naptha/tesseract.js
License: Apache-2.0 (LICENSE and worker.min.js.LICENSE.txt included)

tesseract-core-lstm.wasm.js: tesseract.js-core 7.0.0
Source: https://github.com/naptha/tesseract.js-core
License: Apache-2.0. This distribution embeds the WASM bytes in JavaScript.
The portable non-SIMD LSTM build is selected explicitly for compatibility.

eng.traineddata: tesseract-ocr/tessdata_fast tag 4.1.0
Source: https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/4.1.0/eng.traineddata
License: Apache-2.0 (TRAINEDDATA-LICENSE included)

All runtime files are served from this website. OCR inputs remain on the user's
device. There is no external OCR service, paid API, or default CDN request.
