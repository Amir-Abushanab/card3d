# Third-party notices

Card Studio, the `@card3d/*` packages and the native libraries are MIT-licensed (see
[LICENSE](./LICENSE)). They include code, fonts and scene environments from the following projects under
their own licenses. The card engine's code includes ports of Paper Shaders, three.js, drei and Earcut,
and is compiled with the Rust crates listed at the end.

This file ships with everything that carries the card engine, the fonts or the scene environments:

- `@card3d/core` and `@card3d/element` (npm): the engine's WebGPU and WebGL 2 wasm builds, the fonts and
  the environments.
- The Card3D Swift package (`apple/`): the engine as `libcard3d.a` in `Card3DFFI.xcframework`, with the
  fonts compiled in; this file and the environments are in the package's resources
  (`Sources/Card3D/Resources/`, copied in by `apple/build-xcframework.sh`).
- The Android library (`android/`): the engine as `libcard3d.so`, with the fonts compiled in; this file
  and the environments are in the AAR's assets (`assets/card3d/`).

## Paper Shaders

The card engine's liquid metal is ported from [Paper Shaders](https://github.com/paper-design/shaders)
(`@paper-design/shaders` 0.0.80): the shared vertex shader and the liquid-metal fragment shader in
`crates/card3d-engine/shaders/liquid-metal.wgsl` (with `shaders/face/liquid-metal.wgsl`, the face
shader layer that shows it), and the hex colour parser and `toProcessedLiquidMetal` in
`crates/card3d-engine/src/liquid_metal.rs`. They were first vendored as TypeScript and GLSL in the
three.js engine's `packages/core/src/shaders/library/liquid-metal/paper.ts` (now in a local archive,
not in this repository) and ported from there to WGSL and Rust. They are used by the `liquid-metal`
face shader.

Paper Shaders' NOTICE:

```
Paper Shaders
Copyright 2026 Paper

Powered by Paper Shaders:
https://shaders.paper.design
```

Paper Shaders is licensed under the Apache License, Version 2.0:

```
                                 Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/

   TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION

   1. Definitions.

      "License" shall mean the terms and conditions for use, reproduction,
      and distribution as defined by Sections 1 through 9 of this document.

      "Licensor" shall mean the copyright owner or entity authorized by
      the copyright owner that is granting the License.

      "Legal Entity" shall mean the union of the acting entity and all
      other entities that control, are controlled by, or are under common
      control with that entity. For the purposes of this definition,
      "control" means (i) the power, direct or indirect, to cause the
      direction or management of such entity, whether by contract or
      otherwise, or (ii) ownership of fifty percent (50%) or more of the
      outstanding shares, or (iii) beneficial ownership of such entity.

      "You" (or "Your") shall mean an individual or Legal Entity
      exercising permissions granted by this License.

      "Source" form shall mean the preferred form for making modifications,
      including but not limited to software source code, documentation
      source, and configuration files.

      "Object" form shall mean any form resulting from mechanical
      transformation or translation of a Source form, including but
      not limited to compiled object code, generated documentation,
      and conversions to other media types.

      "Work" shall mean the work of authorship, whether in Source or
      Object form, made available under the License, as indicated by a
      copyright notice that is included in or attached to the work
      (an example is provided in the Appendix below).

      "Derivative Works" shall mean any work, whether in Source or Object
      form, that is based on (or derived from) the Work and for which the
      editorial revisions, annotations, elaborations, or other modifications
      represent, as a whole, an original work of authorship. For the purposes
      of this License, Derivative Works shall not include works that remain
      separable from, or merely link (or bind by name) to the interfaces of,
      the Work and Derivative Works thereof.

      "Contribution" shall mean any work of authorship, including
      the original version of the Work and any modifications or additions
      to that Work or Derivative Works thereof, that is intentionally
      submitted to Licensor for inclusion in the Work by the copyright owner
      or by an individual or Legal Entity authorized to submit on behalf of
      the copyright owner. For the purposes of this definition, "submitted"
      means any form of electronic, verbal, or written communication sent
      to the Licensor or its representatives, including but not limited to
      communication on electronic mailing lists, source code control systems,
      and issue tracking systems that are managed by, or on behalf of, the
      Licensor for the purpose of discussing and improving the Work, but
      excluding communication that is conspicuously marked or otherwise
      designated in writing by the copyright owner as "Not a Contribution."

      "Contributor" shall mean Licensor and any individual or Legal Entity
      on behalf of whom a Contribution has been received by Licensor and
      subsequently incorporated within the Work.

   2. Grant of Copyright License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      copyright license to reproduce, prepare Derivative Works of,
      publicly display, publicly perform, sublicense, and distribute the
      Work and such Derivative Works in Source or Object form.

   3. Grant of Patent License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      (except as stated in this section) patent license to make, have made,
      use, offer to sell, sell, import, and otherwise transfer the Work,
      where such license applies only to those patent claims licensable
      by such Contributor that are necessarily infringed by their
      Contribution(s) alone or by combination of their Contribution(s)
      with the Work to which such Contribution(s) was submitted. If You
      institute patent litigation against any entity (including a
      cross-claim or counterclaim in a lawsuit) alleging that the Work
      or a Contribution incorporated within the Work constitutes direct
      or contributory patent infringement, then any patent licenses
      granted to You under this License for that Work shall terminate
      as of the date such litigation is filed.

   4. Redistribution. You may reproduce and distribute copies of the
      Work or Derivative Works thereof in any medium, with or without
      modifications, and in Source or Object form, provided that You
      meet the following conditions:

      (a) You must give any other recipients of the Work or
          Derivative Works a copy of this License; and

      (b) You must cause any modified files to carry prominent notices
          stating that You changed the files; and

      (c) You must retain, in the Source form of any Derivative Works
          that You distribute, all copyright, patent, trademark, and
          attribution notices from the Source form of the Work,
          excluding those notices that do not pertain to any part of
          the Derivative Works; and

      (d) If the Work includes a "NOTICE" text file as part of its
          distribution, then any Derivative Works that You distribute must
          include a readable copy of the attribution notices contained
          within such NOTICE file, excluding those notices that do not
          pertain to any part of the Derivative Works, in at least one
          of the following places: within a NOTICE text file distributed
          as part of the Derivative Works; within the Source form or
          documentation, if provided along with the Derivative Works; or,
          within a display generated by the Derivative Works, if and
          wherever such third-party notices normally appear. The contents
          of the NOTICE file are for informational purposes only and
          do not modify the License. You may add Your own attribution
          notices within Derivative Works that You distribute, alongside
          or as an addendum to the NOTICE text from the Work, provided
          that such additional attribution notices cannot be construed
          as modifying the License.

      You may add Your own copyright statement to Your modifications and
      may provide additional or different license terms and conditions
      for use, reproduction, or distribution of Your modifications, or
      for any such Derivative Works as a whole, provided Your use,
      reproduction, and distribution of the Work otherwise complies with
      the conditions stated in this License.

   5. Submission of Contributions. Unless You explicitly state otherwise,
      any Contribution intentionally submitted for inclusion in the Work
      by You to the Licensor shall be under the terms and conditions of
      this License, without any additional terms or conditions.
      Notwithstanding the above, nothing herein shall supersede or modify
      the terms of any separate license agreement you may have executed
      with Licensor regarding such Contributions.

   6. Trademarks. This License does not grant permission to use the trade
      names, trademarks, service marks, or product names of the Licensor,
      except as required for reasonable and customary use in describing the
      origin of the Work and reproducing the content of the NOTICE file.

   7. Disclaimer of Warranty. Unless required by applicable law or
      agreed to in writing, Licensor provides the Work (and each
      Contributor provides its Contributions) on an "AS IS" BASIS,
      WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or
      implied, including, without limitation, any warranties or conditions
      of TITLE, NON-INFRINGEMENT, MERCHANTABILITY, or FITNESS FOR A
      PARTICULAR PURPOSE. You are solely responsible for determining the
      appropriateness of using or redistributing the Work and assume any
      risks associated with Your exercise of permissions under this License.

   8. Limitation of Liability. In no event and under no legal theory,
      whether in tort (including negligence), contract, or otherwise,
      unless required by applicable law (such as deliberate and grossly
      negligent acts) or agreed to in writing, shall any Contributor be
      liable to You for damages, including any direct, indirect, special,
      incidental, or consequential damages of any character arising as a
      result of this License or out of the use or inability to use the
      Work (including but not limited to damages for loss of goodwill,
      work stoppage, computer failure or malfunction, or any and all
      other commercial damages or losses), even if such Contributor
      has been advised of the possibility of such damages.

   9. Accepting Warranty or Additional Liability. While redistributing
      the Work or Derivative Works thereof, You may choose to offer,
      and charge a fee for, acceptance of support, warranty, indemnity,
      or other liability obligations and/or rights consistent with this
      License. However, in accepting such obligations, You may act only
      on Your own behalf and on Your sole responsibility, not on behalf
      of any other Contributor, and only if You agree to indemnify,
      defend, and hold each Contributor harmless for any liability
      incurred by, or claims asserted against, such Contributor by reason
      of your accepting any such warranty or additional liability.

   END OF TERMS AND CONDITIONS

   APPENDIX: How to apply the Apache License to your work.

      To apply the Apache License to your work, attach the following
      boilerplate notice, with the fields enclosed by brackets "[]"
      replaced with your own identifying information. (Don't include
      the brackets!)  The text should be enclosed in the appropriate
      comment syntax for the file format. We also recommend that a
      file or class name and description of purpose be included on the
      same "printed page" as the copyright notice for easier
      identification within third-party archives.

   Copyright [yyyy] [name of copyright owner]

   Licensed under the Apache License, Version 2.0 (the "License");
   you may not use this file except in compliance with the License.
   You may obtain a copy of the License at

       http://www.apache.org/licenses/LICENSE-2.0

   Unless required by applicable law or agreed to in writing, software
   distributed under the License is distributed on an "AS IS" BASIS,
   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   See the License for the specific language governing permissions and
   limitations under the License.
```

## Scene environments (Poly Haven, CC0 1.0)

`packages/core/assets/environments/*.webp` (and their copies next to the `<metal-card>` standalone
bundle, `dist/standalone/environments/`, in the Swift package's resources and in the Android library's
assets) are HDRIs from [Poly Haven](https://polyhaven.com), released
under [CC0 1.0 Universal](https://creativecommons.org/publicdomain/zero/1.0/) (public domain dedication:
no attribution is required; we credit the authors anyway). Each was downloaded through Poly Haven's API
(`api.polyhaven.com/files/<id>`) from its CDN (`dl.polyhaven.org`) as the 1k (1024 × 512) Radiance
`.hdr` and re-encoded by `scripts/build-environments.mjs` into a gain-mapped WebP (base image + log2
gain, about a tenth of the size). The original files are not in this repository.

| file | Poly Haven asset | author |
| --- | --- | --- |
| `softbox.webp` | [Studio Small 09](https://polyhaven.com/a/studio_small_09) (`studio_small_09`) | Sergej Majboroda |
| `cyclorama.webp` | [Cyclorama Hard Light](https://polyhaven.com/a/cyclorama_hard_light) (`cyclorama_hard_light`) | Sergej Majboroda |
| `loft.webp` | [Brown Photostudio 02](https://polyhaven.com/a/brown_photostudio_02) (`brown_photostudio_02`) | Sergej Majboroda |
| `warm-hall.webp` | [Photo Studio Loft Hall](https://polyhaven.com/a/photo_studio_loft_hall) (`photo_studio_loft_hall`) | Sergej Majboroda |
| `sunset.webp` | [Venice Sunset](https://polyhaven.com/a/venice_sunset) (`venice_sunset`) | Greg Zaal |

CC0 1.0 in short (the deed's summary; the legal code is at
https://creativecommons.org/publicdomain/zero/1.0/legalcode): the person who associated a work with
this deed has dedicated the work to the public domain by waiving all of their rights to the work
worldwide under copyright law, including all related and neighboring rights, to the extent allowed by
law. You can copy, modify, distribute and perform the work, even for commercial purposes, all without
asking permission.

## Contactless Indicator (EMVCo)

The contactless mark (`packages/core/src/card/contactless.ts` and the engine's
`crates/card3d-engine/src/mark.rs`, off by default) is a tracing of the EMVCo
Contactless Indicator. The Contactless Indicator mark, consisting of four graduating arcs, is a trademark
owned by EMVCo, LLC. This project is not licensed by, affiliated with or endorsed by EMVCo.

## Mediabunny (Card Studio app)

The Card Studio app (not the `@card3d/*` packages) encodes its video exports with
[Mediabunny](https://github.com/Vanilagy/mediabunny) 1.62.1, loaded only when a video is recorded. It is
licensed under the Mozilla Public License 2.0 (https://mozilla.org/MPL/2.0/) and used unmodified; its
source is at https://github.com/Vanilagy/mediabunny.

## three.js

The card engine (`crates/card3d-engine`, shipped as the wasm builds in `@card3d/core`'s `wasm/` and
`@card3d/element`'s `dist/standalone/engine/`, and in the Apple and Android native libraries) includes code ported from
[three.js](https://github.com/mrdoob/three.js) r180: the shape, extrusion and tube machinery
(`ExtrudeGeometry` with `WorldUVGenerator`, `Shape` / `Path`, `ShapeUtils`, in `src/extrude.rs`), the
PMREM generator and its CUBEUV
atlas (`src/env.rs`, `shaders/env.wgsl`, `shaders/cubeuv.wgsl`, `shaders/scene-env.wgsl`) and the
`MeshPhysicalMaterial` shader chunks (`shaders/card.wgsl`), plus smaller pieces named in each file's
header. The packages don't include or depend on three.js itself.

```
The MIT License

Copyright © 2010-2025 three.js authors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

## drei

The clear glass card's material (`fs_glass` in `crates/card3d-engine/shaders/card.wgsl`, set up by
`src/glass.rs`) is ported from drei's `MeshTransmissionMaterial`
([pmndrs/drei](https://github.com/pmndrs/drei)).

```
MIT License

Copyright (c) 2020 react-spring

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Earcut

The polygon triangulation in `crates/card3d-engine/src/extrude.rs` is ported from three.js r180's copy
of [Earcut](https://github.com/mapbox/earcut) 3.0.1.

```
ISC License

Copyright (c) 2024, Mapbox

Permission to use, copy, modify, and/or distribute this software for any purpose
with or without fee is hereby granted, provided that the above copyright notice
and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND
FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS
OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER
TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF
THIS SOFTWARE.
```

## Fonts (SIL Open Font License 1.1)

The card fonts in `packages/core/assets/fonts/` (the name/bio font picker, `CARD_FONTS` in
`packages/core/src/fonts.ts`) are unmodified WOFF2 files from the [Fontsource](https://fontsource.org)
npm packages, version 5.3.0 (the latin and latin-ext subsets, as Google Fonts serves them). Each is
licensed under the SIL Open Font License, Version 1.1; the full licence text with each font's copyright
line is in `packages/core/assets/fonts/licenses/<font>-OFL.txt` (in the published packages:
`@card3d/core/assets/fonts/licenses/`, and `dist/standalone/fonts/licenses/` in `@card3d/element`), and the copyright lines are repeated
below. The fonts are registered under card3d family names (e.g. "card3d Inter") only so a locally
installed copy is never picked up instead; the font files and their internal names are unchanged.

The native libraries (Apple and Android) compile in the same WOFF2 files listed below (unchanged;
decoded in memory when first used), under the same licence; their licence files are also beside the
native host's source (`crates/card3d-native/assets/`).

| font | files | weight | upstream | package |
|---|---|---|---|---|
| Inter | `inter-latin-wght-normal.woff2`, `inter-latin-ext-wght-normal.woff2` | variable weight 100–900 (the card name/bio's default face and the studio's UI face) | [rsms/inter](https://github.com/rsms/inter) | `@fontsource-variable/inter` 5.3.0 |
| Manrope | `manrope-latin-700-normal.woff2`, `manrope-latin-ext-700-normal.woff2` | 700 | [sharanda/manrope](https://github.com/sharanda/manrope) | `@fontsource/manrope` 5.3.0 |
| Space Grotesk | `space-grotesk-latin-700-normal.woff2`, `space-grotesk-latin-ext-700-normal.woff2` | 700 | [floriankarsten/space-grotesk](https://github.com/floriankarsten/space-grotesk) | `@fontsource/space-grotesk` 5.3.0 |
| Unbounded | `unbounded-latin-700-normal.woff2`, `unbounded-latin-ext-700-normal.woff2` | 700 | [googlefonts/unbounded](https://github.com/googlefonts/unbounded) | `@fontsource/unbounded` 5.3.0 |
| Playfair Display | `playfair-display-latin-700-normal.woff2`, `playfair-display-latin-ext-700-normal.woff2` | 700 | [clauseggers/Playfair-Display](https://github.com/clauseggers/Playfair-Display) | `@fontsource/playfair-display` 5.3.0 |
| IBM Plex Mono | `ibm-plex-mono-latin-700-normal.woff2`, `ibm-plex-mono-latin-ext-700-normal.woff2` | 700 | [IBM/plex](https://github.com/IBM/plex) | `@fontsource/ibm-plex-mono` 5.3.0 |

- Inter: Copyright 2016 The Inter Project Authors (https://github.com/rsms/inter)
- Manrope: Copyright 2019 The Manrope Project Authors (https://github.com/sharanda/manrope)
- Space Grotesk: Copyright 2020 The Space Grotesk Project Authors (https://github.com/floriankarsten/space-grotesk)
- Unbounded: Copyright 2022 The Unbounded Project Authors (https://github.com/googlefonts/unbounded)
- Playfair Display: Copyright 2017 The Playfair Display Project Authors (https://github.com/clauseggers/Playfair-Display), with Reserved Font Name "Playfair Display"
- IBM Plex Mono: Copyright 2017 IBM Corp. All rights reserved.

The SIL Open Font License, Version 1.1 (identical in each licence file after the copyright lines):

```
This Font Software is licensed under the SIL Open Font License, Version 1.1.
This license is copied below, and is also available with a FAQ at:
http://scripts.sil.org/OFL


-----------------------------------------------------------
SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007
-----------------------------------------------------------

PREAMBLE
The goals of the Open Font License (OFL) are to stimulate worldwide
development of collaborative font projects, to support the font creation
efforts of academic and linguistic communities, and to provide a free and
open framework in which fonts may be shared and improved in partnership
with others.

The OFL allows the licensed fonts to be used, studied, modified and
redistributed freely as long as they are not sold by themselves. The
fonts, including any derivative works, can be bundled, embedded,
redistributed and/or sold with any software provided that any reserved
names are not used by derivative works. The fonts and derivatives,
however, cannot be released under any other type of license. The
requirement for fonts to remain under this license does not apply
to any document created using the fonts or their derivatives.

DEFINITIONS
"Font Software" refers to the set of files released by the Copyright
Holder(s) under this license and clearly marked as such. This may
include source files, build scripts and documentation.

"Reserved Font Name" refers to any names specified as such after the
copyright statement(s).

"Original Version" refers to the collection of Font Software components as
distributed by the Copyright Holder(s).

"Modified Version" refers to any derivative made by adding to, deleting,
or substituting -- in part or in whole -- any of the components of the
Original Version, by changing formats or by porting the Font Software to a
new environment.

"Author" refers to any designer, engineer, programmer, technical
writer or other person who contributed to the Font Software.

PERMISSION & CONDITIONS
Permission is hereby granted, free of charge, to any person obtaining
a copy of the Font Software, to use, study, copy, merge, embed, modify,
redistribute, and sell modified and unmodified copies of the Font
Software, subject to the following conditions:

1) Neither the Font Software nor any of its individual components,
in Original or Modified Versions, may be sold by itself.

2) Original or Modified Versions of the Font Software may be bundled,
redistributed and/or sold with any software, provided that each copy
contains the above copyright notice and this license. These can be
included either as stand-alone text files, human-readable headers or
in the appropriate machine-readable metadata fields within text or
binary files as long as those fields can be easily viewed by the user.

3) No Modified Version of the Font Software may use the Reserved Font
Name(s) unless explicit written permission is granted by the corresponding
Copyright Holder. This restriction only applies to the primary font name as
presented to the users.

4) The name(s) of the Copyright Holder(s) or the Author(s) of the Font
Software shall not be used to promote, endorse or advertise any
Modified Version, except to acknowledge the contribution(s) of the
Copyright Holder(s) and the Author(s) or with their explicit written
permission.

5) The Font Software, modified or unmodified, in part or in whole,
must be distributed entirely under this license, and must not be
distributed under any other license. The requirement for fonts to
remain under this license does not apply to any document created
using the Font Software.

TERMINATION
This license becomes null and void if any of the above conditions are
not met.

DISCLAIMER
THE FONT SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO ANY WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT
OF COPYRIGHT, PATENT, TRADEMARK, OR OTHER RIGHT. IN NO EVENT SHALL THE
COPYRIGHT HOLDER BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
INCLUDING ANY GENERAL, SPECIAL, INDIRECT, INCIDENTAL, OR CONSEQUENTIAL
DAMAGES, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF THE USE OR INABILITY TO USE THE FONT SOFTWARE OR FROM
OTHER DEALINGS IN THE FONT SOFTWARE.
```

<!-- BEGIN rust-crates: generated by scripts/third-party-rust.mjs from Cargo.lock; do not edit by hand -->

## Rust crates

The card engine is compiled together with the Rust standard library and the crates below. Builds: **web**, the WebGPU build (`wasm/pkg/`); **webgl**, the WebGL 2 build (`wasm/pkg-webgl/`); **apple**, `libcard3d.a` in `Card3DFFI.xcframework` (iOS, iOS simulator, macOS); **android**, `libcard3d.so` in the Android library (arm64-v8a, x86_64). The web builds ship in `@card3d/core` (`wasm/`) and `@card3d/element` (`dist/standalone/engine/`).

| build | third-party crates |
| --- | --- |
| web | 33 |
| webgl | 53 |
| apple | 107 |
| android | 119 |

Each web build's JavaScript glue (`card3d_web.js`) is generated by wasm-bindgen-cli 0.2.130 and its chunk loader (`__wasm_split.*.js`) by wasm_split_cli_support 0.2.5, from the projects listed here as `wasm-bindgen` and `wasm_split_helpers` (same licences and authors).

Build scripts and procedural macros run only at build time and are not listed. A crate offering a choice of licences is listed under the first of MIT, Zlib, ISC, BSD-2-Clause, BSD-3-Clause, Apache-2.0 that it ships a text for; one requiring two is listed under both. Each licence text is printed once, after the crates it covers, with their copyright lines in the list.

### MIT License (1 of 3)

- `adler2` 2.0.1 (apple, android): the adler2 authors (Jonas Schievink, oyvindln)
- `allocator-api2` 0.2.21 (android): the allocator-api2 authors (Zakarum)
- `android_system_properties` 0.1.6 (android): Copyright (c) 2013 Nicolas Silva
- `arrayvec` 0.7.8 (web, webgl, apple, android): Copyright (c) Ulrik Sverdrup "bluss" 2015-2023
- `ash` 0.38.0+1.3.281 (android): Copyright (c) 2016 ASH
- `async-once-cell` 0.5.4 (web, webgl, apple, android): Copyright (c) 2023 Daniel De Graaf
- `base64` 0.23.1 (apple, android): Copyright (c) 2025 Alice Maz, Marshall Pierce
- `bit-set` 0.10.0 (webgl, apple, android): Copyright (c) 2026 The Rust Project Developers
- `bit-vec` 0.9.1 (webgl, apple, android): Copyright (c) 2023 The Rust Project Developers
- `bitflags` 2.13.2 (web, webgl, apple, android): Copyright (c) 2014 The Rust Project Developers
- `block2` 0.6.2 (apple): Copyright 2026 Mads Marquart [licence from https://github.com/madsmtm/objc2 (LICENSE-MIT.txt); the package has none]
- `byteorder-lite` 0.1.0 (apple, android): Copyright (c) 2015 Andrew Gallant
- `bytes` 1.12.1 (apple, android): Copyright (c) 2018 Carl Lerche
- `cfg-if` 1.0.5 (web, webgl, apple, android): Copyright (c) 2014 Alex Crichton
- `color_quant` 1.1.0 (apple, android): Copyright (c) 2016 PistonDevelopers
- `combine` 4.6.9 (android): Copyright (c) 2015 Markus Westerlind
- `console_error_panic_hook` 0.1.7 (web, webgl): Copyright (c) 2018 Nick Fitzgerald
- `crc32fast` 1.5.5 (apple, android): Copyright (c) 2018 Sam Rijs, Alex Crichton and contributors
- `dlib` 0.5.3 (android): Copyright (c) 2015 Victor Berger
- `equivalent` 1.0.3 (web, webgl, apple, android): Copyright (c) 2016--2023
- `fdeflate` 0.3.7 (apple, android): the fdeflate authors (The image-rs Developers)
- `flate2` 1.1.11 (apple, android): Copyright (c) 2014-2026 Alex Crichton
- `form_urlencoded` 1.2.2 (apple, android): Copyright (c) 2013-2016 The rust-url developers
- `futures-core` 0.3.34 (web, webgl): Copyright (c) 2016 Alex Crichton Copyright (c) 2017 The Tokio Authors
- `futures-task` 0.3.34 (web, webgl): Copyright (c) 2016 Alex Crichton Copyright (c) 2017 The Tokio Authors
- `futures-util` 0.3.34 (web, webgl): Copyright (c) 2016 Alex Crichton Copyright (c) 2017 The Tokio Authors
- `gif` 0.14.2 (apple, android): Copyright (c) 2015 nwin
- `glam` 0.34.3 (web, webgl, apple, android): Copyright 2020 Cameron Hart
- `glow` 0.17.0 (webgl, android): the glow authors (Joshua Groves, Dzmitry Malyshau)
- `gpu-allocator` 0.28.0 (android): Copyright (c) 2021 Traverse Research B.V.
- `half` 2.7.1 (webgl, apple, android): the half authors (Kathryn Long)
- `hashbrown` 0.16.1 (android): Copyright (c) 2016 Amanieu d'Antras
- `hashbrown` 0.17.1 (web, webgl, apple, android): Copyright (c) 2016 Amanieu d'Antras
- `idna` 1.1.0 (apple, android): Copyright (c) 2013-2025 The rust-url developers
- `idna_adapter` 1.2.2 (apple, android): Copyright (c) The rust-url developers
- `image` 0.25.10 (apple, android): the image authors (The image-rs Developers)
- `image-webp` 0.2.4 (apple, android): the image-webp authors
- `indexmap` 2.14.2 (web, webgl, apple, android): Copyright (c) 2016--2017
- `jni` 0.22.4 (android): Copyright (c) 2016 Prevoty, Inc. and jni-rs contributors [licence from https://github.com/jni-rs/jni-rs (LICENSE-MIT); the package has none]
- `jni-sys` 0.3.1 (android): Copyright (c) 2015 The rust-jni-sys Developers
- `jni-sys` 0.4.1 (android): Copyright (c) 2015 The rust-jni-sys Developers
- `js-sys` 0.3.107 (web, webgl): Copyright (c) 2014 Alex Crichton
- `khronos-egl` 6.0.0 (android): the khronos-egl authors (Timothée Haudebourg, Sean Kerr)
- `libc` 0.2.191 (apple, android): Copyright (c) The Rust Project Developers
- `lock_api` 0.4.14 (webgl, apple, android): Copyright (c) 2016 The Rust Project Developers
- `log` 0.4.35 (web, webgl, apple, android): Copyright (c) 2014 The Rust Project Developers
- `memchr` 2.8.3 (android): Copyright (c) 2015 Andrew Gallant
- `miniz_oxide` 0.8.9 (apple, android): Copyright 2013-2014 RAD Game Tools and Valve Software Copyright 2010-2014 Rich Geldreich and Tenacious Software LLC Copyright (c) 2017 Frommi Copyright (c) 2017-2024 oyvindln
- `miniz_oxide` 0.9.1 (apple, android): Copyright 2013-2014 RAD Game Tools and Valve Software Copyright 2010-2014 Rich Geldreich and Tenacious Software LLC Copyright (c) 2017 Frommi Copyright (c) 2017-2024 oyvindln
- `naga` 30.0.2 (webgl, apple, android): Copyright (c) 2025 The gfx-rs developers
- `naga-types` 30.0.2 (web, webgl, apple, android): Copyright (c) 2025 The gfx-rs developers
- `ndk-sys` 0.6.0+11769913 (android): the ndk-sys authors (The Rust Windowing contributors) [licence from https://github.com/rust-mobile/ndk (LICENSE-MIT, which has no copyright line); the package has none]
- `num-traits` 0.2.19 (webgl, apple, android): Copyright (c) 2014 The Rust Project Developers
- `objc2` 0.6.5 (apple): Copyright 2026 Mads Marquart [licence from https://github.com/madsmtm/objc2 (LICENSE-MIT.txt); the package has none]
- `objc2-core-foundation` 0.3.2 (apple): Copyright 2026 Mads Marquart [licence from https://github.com/madsmtm/objc2 (LICENSE-MIT.txt); the package has none]
- `objc2-core-graphics` 0.3.2 (apple): Copyright 2026 Mads Marquart [licence from https://github.com/madsmtm/objc2 (LICENSE-MIT.txt); the package has none]
- `objc2-encode` 4.1.0 (apple): Copyright 2026 Mads Marquart [licence from https://github.com/madsmtm/objc2 (LICENSE-MIT.txt); the package has none]
- `objc2-foundation` 0.3.2 (apple): Copyright 2026 Mads Marquart [licence from https://github.com/madsmtm/objc2 (LICENSE-MIT.txt); the package has none]
- `objc2-metal` 0.3.2 (apple): Copyright 2026 Mads Marquart [licence from https://github.com/madsmtm/objc2 (LICENSE-MIT.txt); the package has none]
- `objc2-quartz-core` 0.3.2 (apple): Copyright 2026 Mads Marquart [licence from https://github.com/madsmtm/objc2 (LICENSE-MIT.txt); the package has none]
- `once_cell` 1.21.4 (webgl, apple, android): the once_cell authors (Aleksey Kladov)
- `ordered-float` 5.5.1 (android): Copyright (c) 2015 Jonathan Reem
- `parking_lot` 0.12.5 (webgl, apple, android): Copyright (c) 2016 The Rust Project Developers
- `parking_lot_core` 0.9.12 (webgl, apple, android): Copyright (c) 2016 The Rust Project Developers
- `percent-encoding` 2.3.2 (apple, android): Copyright (c) 2013-2025 The rust-url developers
- `pin-project-lite` 0.2.17 (web, webgl): the pin-project-lite authors
- `png` 0.18.1 (apple, android): Copyright (c) 2015 nwin
- `pollster` 1.0.2 (apple, android): Copyright (c) 2020-2021 Joshua Barretto
- `presser` 0.3.1 (android): Copyright (c) 2019 Embark Studios
- `profiling` 1.0.18 (web, webgl, apple, android): Copyright (c) 2020 Philip Degarmo and other contributors [licence from https://github.com/aclysma/profiling (LICENSE-MIT); the package has none]
- `quick-error` 2.0.1 (apple, android): Copyright (c) 2015 The quick-error Developers
- `raw-window-handle` 0.6.2 (web, webgl, apple, android): Copyright (c) 2019 Osspial
- `raw-window-metal` 1.1.0 (apple): the raw-window-metal authors
- `renderdoc-sys` 1.1.0 (android): Copyright (c) 2022 Eyal Kalderon
- Rust standard library (web, webgl, apple, android): Copyrights in the Rust Standard Library are retained by their contributors (The Rust Project Developers, https://thanks.rust-lang.org). [`core`, `alloc` and `std`, MIT OR Apache-2.0; the crates it is built from are listed in the toolchain's `share/doc/rust/COPYRIGHT-library.html`]
- `rustc-hash` 1.1.0 (web, webgl, apple, android): the rustc-hash authors (The Rust Project Developers)
- `scopeguard` 1.2.0 (webgl, apple, android): Copyright (c) 2016-2019 Ulrik Sverdrup "bluss" and scopeguard developers
- `simd_cesu8` 1.2.0 (android): the simd_cesu8 authors (Sean C. Roach)
- `simd-adler32` 0.3.10 (apple, android): Copyright (c) [2021] [Marvin Countryman]
- `simdutf8` 0.1.5 (android): the simdutf8 authors (Hans Kratz)
- `slab` 0.4.12 (web, webgl): Copyright (c) 2019 Carl Lerche
- `smallvec` 1.16.5 (webgl, apple, android): Copyright (c) 2018 The Servo Project Developers
- `stable_deref_trait` 1.2.1 (apple, android): Copyright (c) 2017 Robert Grosse
- `static_assertions` 1.1.0 (web, webgl, apple, android): Copyright (c) 2017 Nikolai Vazquez
- `strict-num` 0.1.1 (apple, android): Copyright (c) 2022 Yevhenii Reizner
- `thiserror` 2.0.21 (web, webgl, apple, android): the thiserror authors (David Tolnay)
- `ttf-parser` 0.25.1 (apple, android): Copyright (c) 2018 Yevhenii Reizner
- `unicode-ident` 1.0.27 (web, webgl, apple, android): Copyright © 1991-2023 Unicode, Inc.
- `unicode-width` 0.2.3 (webgl, apple, android): Copyright (c) 2015 The Rust Project Developers
- `url` 2.5.8 (apple, android): Copyright (c) 2013-2025 The rust-url developers
- `utf_types` 1.0.0 (apple, android): Copyright Mozilla Foundation
- `utf8_iter` 1.1.0 (apple, android): Copyright Mozilla Foundation
- `wasm_split_helpers` 0.2.3 (web, webgl, apple, android): the wasm_split_helpers authors (Greg Johnston, Jeremy Maitin-Shepard, Martin Molzer) [licence from https://github.com/WorldSEnder/wasm-split-prototype (whose LICENSE is the Apache text); the package has none]
- `wasm-bindgen` 0.2.130 (web, webgl): Copyright (c) 2014 Alex Crichton
- `wasm-bindgen-futures` 0.4.80 (web, webgl): Copyright (c) 2014 Alex Crichton
- `wasm-bindgen-shared` 0.2.130 (web, webgl): Copyright (c) 2014 Alex Crichton
- `wayland-sys` 0.31.11 (android): Copyright (c) 2015 Elinor Berger
- `web-sys` 0.3.107 (web, webgl): Copyright (c) 2014 Alex Crichton
- `weezl` 0.1.12 (apple, android): Copyright (c) HeroicKatora 2020
- `wgpu` 30.0.2 (web, webgl, apple, android): Copyright (c) 2025 The gfx-rs developers
- `wgpu-core` 30.0.2 (webgl, apple, android): Copyright (c) 2025 The gfx-rs developers
- `wgpu-core-deps-apple` 30.0.2 (apple): Copyright (c) 2025 The gfx-rs developers
- `wgpu-core-deps-wasm` 30.0.2 (webgl): Copyright (c) 2025 The gfx-rs developers
- `wgpu-core-deps-windows-linux-android` 30.0.2 (android): Copyright (c) 2025 The gfx-rs developers
- `wgpu-hal` 30.0.2 (webgl, apple, android): Copyright (c) 2025 The gfx-rs developers
- `wgpu-naga-bridge` 30.0.2 (webgl, apple, android): Copyright (c) 2025 The gfx-rs developers
- `wgpu-types` 30.0.2 (web, webgl, apple, android): Copyright (c) 2025 The gfx-rs developers
- `wuff` 0.2.10 (apple, android): Copyright (c) 2013-2017 by the WOFF2 Authors. Copyright (c) 2025 by Nico Burns. [licence from https://github.com/nicoburns/wuff (LICENSE); the package has none]
- `zerocopy` 0.8.63 (webgl, apple, android): Copyright 2023 The Fuchsia Authors
- `zune-core` 0.5.3 (apple, android): Copyright (c) zune-image developers
- `zune-jpeg` 0.5.15 (apple, android): Copyright (c) zune-image developers

```
Permission is hereby granted, free of charge, to any
person obtaining a copy of this software and associated
documentation files (the "Software"), to deal in the
Software without restriction, including without
limitation the rights to use, copy, modify, merge,
publish, distribute, sublicense, and/or sell copies of
the Software, and to permit persons to whom the Software
is furnished to do so, subject to the following
conditions:

The above copyright notice and this permission notice
shall be included in all copies or substantial portions
of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF
ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED
TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A
PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT
SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION
OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR
IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
DEALINGS IN THE SOFTWARE.
```

### MIT License (2 of 3)

- `bytemuck` 1.25.2 (web, webgl, apple, android): Copyright (c) 2019 Daniel "Lokathor" Gee.

```
Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice (including the next paragraph) shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

### MIT License (3 of 3)

- `libm` 0.2.16 (web, webgl, apple, android): copyright notices in the text below

```
rust-lang/libm as a whole is available for use under the MIT license:

------------------------------------------------------------------------------
Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
------------------------------------------------------------------------------

As a contributor, you agree that your code can be used under either the MIT
license or the Apache-2.0 license:

------------------------------------------------------------------------------
                                 Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/

   TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION

   1. Definitions.

      "License" shall mean the terms and conditions for use, reproduction,
      and distribution as defined by Sections 1 through 9 of this document.

      "Licensor" shall mean the copyright owner or entity authorized by
      the copyright owner that is granting the License.

      "Legal Entity" shall mean the union of the acting entity and all
      other entities that control, are controlled by, or are under common
      control with that entity. For the purposes of this definition,
      "control" means (i) the power, direct or indirect, to cause the
      direction or management of such entity, whether by contract or
      otherwise, or (ii) ownership of fifty percent (50%) or more of the
      outstanding shares, or (iii) beneficial ownership of such entity.

      "You" (or "Your") shall mean an individual or Legal Entity
      exercising permissions granted by this License.

      "Source" form shall mean the preferred form for making modifications,
      including but not limited to software source code, documentation
      source, and configuration files.

      "Object" form shall mean any form resulting from mechanical
      transformation or translation of a Source form, including but
      not limited to compiled object code, generated documentation,
      and conversions to other media types.

      "Work" shall mean the work of authorship, whether in Source or
      Object form, made available under the License, as indicated by a
      copyright notice that is included in or attached to the work
      (an example is provided in the Appendix below).

      "Derivative Works" shall mean any work, whether in Source or Object
      form, that is based on (or derived from) the Work and for which the
      editorial revisions, annotations, elaborations, or other modifications
      represent, as a whole, an original work of authorship. For the purposes
      of this License, Derivative Works shall not include works that remain
      separable from, or merely link (or bind by name) to the interfaces of,
      the Work and Derivative Works thereof.

      "Contribution" shall mean any work of authorship, including
      the original version of the Work and any modifications or additions
      to that Work or Derivative Works thereof, that is intentionally
      submitted to Licensor for inclusion in the Work by the copyright owner
      or by an individual or Legal Entity authorized to submit on behalf of
      the copyright owner. For the purposes of this definition, "submitted"
      means any form of electronic, verbal, or written communication sent
      to the Licensor or its representatives, including but not limited to
      communication on electronic mailing lists, source code control systems,
      and issue tracking systems that are managed by, or on behalf of, the
      Licensor for the purpose of discussing and improving the Work, but
      excluding communication that is conspicuously marked or otherwise
      designated in writing by the copyright owner as "Not a Contribution."

      "Contributor" shall mean Licensor and any individual or Legal Entity
      on behalf of whom a Contribution has been received by Licensor and
      subsequently incorporated within the Work.

   2. Grant of Copyright License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      copyright license to reproduce, prepare Derivative Works of,
      publicly display, publicly perform, sublicense, and distribute the
      Work and such Derivative Works in Source or Object form.

   3. Grant of Patent License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      (except as stated in this section) patent license to make, have made,
      use, offer to sell, sell, import, and otherwise transfer the Work,
      where such license applies only to those patent claims licensable
      by such Contributor that are necessarily infringed by their
      Contribution(s) alone or by combination of their Contribution(s)
      with the Work to which such Contribution(s) was submitted. If You
      institute patent litigation against any entity (including a
      cross-claim or counterclaim in a lawsuit) alleging that the Work
      or a Contribution incorporated within the Work constitutes direct
      or contributory patent infringement, then any patent licenses
      granted to You under this License for that Work shall terminate
      as of the date such litigation is filed.

   4. Redistribution. You may reproduce and distribute copies of the
      Work or Derivative Works thereof in any medium, with or without
      modifications, and in Source or Object form, provided that You
      meet the following conditions:

      (a) You must give any other recipients of the Work or
          Derivative Works a copy of this License; and

      (b) You must cause any modified files to carry prominent notices
          stating that You changed the files; and

      (c) You must retain, in the Source form of any Derivative Works
          that You distribute, all copyright, patent, trademark, and
          attribution notices from the Source form of the Work,
          excluding those notices that do not pertain to any part of
          the Derivative Works; and

      (d) If the Work includes a "NOTICE" text file as part of its
          distribution, then any Derivative Works that You distribute must
          include a readable copy of the attribution notices contained
          within such NOTICE file, excluding those notices that do not
          pertain to any part of the Derivative Works, in at least one
          of the following places: within a NOTICE text file distributed
          as part of the Derivative Works; within the Source form or
          documentation, if provided along with the Derivative Works; or,
          within a display generated by the Derivative Works, if and
          wherever such third-party notices normally appear. The contents
          of the NOTICE file are for informational purposes only and
          do not modify the License. You may add Your own attribution
          notices within Derivative Works that You distribute, alongside
          or as an addendum to the NOTICE text from the Work, provided
          that such additional attribution notices cannot be construed
          as modifying the License.

      You may add Your own copyright statement to Your modifications and
      may provide additional or different license terms and conditions
      for use, reproduction, or distribution of Your modifications, or
      for any such Derivative Works as a whole, provided Your use,
      reproduction, and distribution of the Work otherwise complies with
      the conditions stated in this License.

   5. Submission of Contributions. Unless You explicitly state otherwise,
      any Contribution intentionally submitted for inclusion in the Work
      by You to the Licensor shall be under the terms and conditions of
      this License, without any additional terms or conditions.
      Notwithstanding the above, nothing herein shall supersede or modify
      the terms of any separate license agreement you may have executed
      with Licensor regarding such Contributions.

   6. Trademarks. This License does not grant permission to use the trade
      names, trademarks, service marks, or product names of the Licensor,
      except as required for reasonable and customary use in describing the
      origin of the Work and reproducing the content of the NOTICE file.

   7. Disclaimer of Warranty. Unless required by applicable law or
      agreed to in writing, Licensor provides the Work (and each
      Contributor provides its Contributions) on an "AS IS" BASIS,
      WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or
      implied, including, without limitation, any warranties or conditions
      of TITLE, NON-INFRINGEMENT, MERCHANTABILITY, or FITNESS FOR A
      PARTICULAR PURPOSE. You are solely responsible for determining the
      appropriateness of using or redistributing the Work and assume any
      risks associated with Your exercise of permissions under this License.

   8. Limitation of Liability. In no event and under no legal theory,
      whether in tort (including negligence), contract, or otherwise,
      unless required by applicable law (such as deliberate and grossly
      negligent acts) or agreed to in writing, shall any Contributor be
      liable to You for damages, including any direct, indirect, special,
      incidental, or consequential damages of any character arising as a
      result of this License or out of the use or inability to use the
      Work (including but not limited to damages for loss of goodwill,
      work stoppage, computer failure or malfunction, or any and all
      other commercial damages or losses), even if such Contributor
      has been advised of the possibility of such damages.

   9. Accepting Warranty or Additional Liability. While redistributing
      the Work or Derivative Works thereof, You may choose to offer,
      and charge a fee for, acceptance of support, warranty, indemnity,
      or other liability obligations and/or rights consistent with this
      License. However, in accepting such obligations, You may act only
      on Your own behalf and on Your sole responsibility, not on behalf
      of any other Contributor, and only if You agree to indemnify,
      defend, and hold each Contributor harmless for any liability
      incurred by, or claims asserted against, such Contributor by reason
      of your accepting any such warranty or additional liability.

   END OF TERMS AND CONDITIONS

   APPENDIX: How to apply the Apache License to your work.

      To apply the Apache License to your work, attach the following
      boilerplate notice, with the fields enclosed by brackets "[]"
      replaced with your own identifying information. (Don't include
      the brackets!)  The text should be enclosed in the appropriate
      comment syntax for the file format. We also recommend that a
      file or class name and description of purpose be included on the
      same "printed page" as the copyright notice for easier
      identification within third-party archives.

   Licensed under the Apache License, Version 2.0 (the "License");
   you may not use this file except in compliance with the License.
   You may obtain a copy of the License at

       http://www.apache.org/licenses/LICENSE-2.0

   Unless required by applicable law or agreed to in writing, software
   distributed under the License is distributed on an "AS IS" BASIS,
   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   See the License for the specific language governing permissions and
   limitations under the License.
------------------------------------------------------------------------------

This Rust library contains the following copyrights:

    Copyright (c) 2018 Jorge Aparicio

Portions of this software are derived from third-party works licensed under
terms compatible with the above MIT license:

* musl libc https://www.musl-libc.org/. This library contains the following
  copyright:

      Copyright © 2005-2020 Rich Felker, et al.

* The CORE-MATH project https://core-math.gitlabpages.inria.fr/. CORE-MATH
  routines are available under the MIT license on a per-file basis.

The musl libc COPYRIGHT file also includes the following notice relevant to
math portions of the library:

------------------------------------------------------------------------------
Much of the math library code (src/math/* and src/complex/*) is
Copyright © 1993,2004 Sun Microsystems or
Copyright © 2003-2011 David Schultz or
Copyright © 2003-2009 Steven G. Kargl or
Copyright © 2003-2009 Bruce D. Evans or
Copyright © 2008 Stephen L. Moshier or
Copyright © 2017-2018 Arm Limited
and labelled as such in comments in the individual source files. All
have been licensed under extremely permissive terms.
------------------------------------------------------------------------------

Copyright notices are retained in src/* files where relevant.
```

### Apache License 2.0

- `ab_glyph` 0.2.32 (apple, android): the ab_glyph authors (Alex Butler)
- `ab_glyph_rasterizer` 0.1.10 (apple, android): the ab_glyph_rasterizer authors (Alex Butler)
- `codespan-reporting` 0.13.1 (webgl, apple, android): the codespan-reporting authors (Brendan Zabarauskas)
- `owned_ttf_parser` 0.25.1 (apple, android): the owned_ttf_parser authors (Alex Butler)
- `spirv` 0.4.0+sdk-1.4.341.0 (android): the spirv authors (Lei Zhang) [licence from https://github.com/gfx-rs/rspirv (LICENSE); the package has none]

The Apache License 2.0 text is printed in full under Paper Shaders, above.

### zlib License

- `foldhash` 0.2.0 (web, webgl, apple, android): Copyright (c) 2024 Orson Peters
- `slotmap` 1.1.1 (webgl): Copyright (c) 2021 Orson Peters <orsonpeters@gmail.com>

```
This software is provided 'as-is', without any express or implied warranty. In
no event will the authors be held liable for any damages arising from the use of
this software.

Permission is granted to anyone to use this software for any purpose, including
commercial applications, and to alter it and redistribute it freely, subject to
the following restrictions:

1. The origin of this software must not be misrepresented; you must not claim
    that you wrote the original software. If you use this software in a product,
    an acknowledgment in the product documentation would be appreciated but is
    not required.

2. Altered source versions must be plainly marked as such, and must not be
    misrepresented as being the original software.

3. This notice may not be removed or altered from any source distribution.
```

### ISC License

- `libloading` 0.8.9 (apple, android): Copyright © 2015, Simonas Kazlauskas

```
Permission to use, copy, modify, and/or distribute this software for any purpose with or without
fee is hereby granted, provided that the above copyright notice and this permission notice appear
in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH REGARD TO THIS
SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE
AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT,
NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF
THIS SOFTWARE.
```

### BSD 2-Clause License

- `arrayref` 0.3.9 (apple, android): Copyright (c) 2015 David Roundy <roundyd@physics.oregonstate.edu> All rights reserved.

```
Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are
met:

1. Redistributions of source code must retain the above copyright
   notice, this list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright
   notice, this list of conditions and the following disclaimer in the
   documentation and/or other materials provided with the
   distribution.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
"AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT
HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

### BSD 3-Clause License (1 of 2)

- `alloc-no-stdlib` 3.0.0 (apple, android): Copyright (c) 2016 Dropbox, Inc. All rights reserved.
- `brotli-decompressor` 6.3.2 (apple, android): Copyright (c) 2016 Dropbox, Inc. All rights reserved.
- `moxcms` 0.8.1 (apple, android): Copyright (c) Radzivon Bartoshyk. All rights reserved.
- `pxfm` 0.1.30 (apple, android): Copyright (c) Radzivon Bartoshyk. All rights reserved.

```
Redistribution and use in source and binary forms, with or without modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the following disclaimer in the documentation and/or other materials provided with the distribution.

3. Neither the name of the copyright holder nor the names of its contributors may be used to endorse or promote products derived from this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

### BSD 3-Clause License (2 of 2)

- `tiny-skia` 0.12.0 (apple, android): Copyright (c) 2011 Google Inc. All rights reserved. Copyright (c) 2020 Yevhenii Reizner All rights reserved.
- `tiny-skia-path` 0.12.0 (apple, android): Copyright (c) 2011 Google Inc. All rights reserved. Copyright (c) 2020 Yevhenii Reizner All rights reserved.

```
Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are
met:

  * Redistributions of source code must retain the above copyright
    notice, this list of conditions and the following disclaimer.

  * Redistributions in binary form must reproduce the above copyright
    notice, this list of conditions and the following disclaimer in
    the documentation and/or other materials provided with the
    distribution.

  * Neither the name of the copyright holder nor the names of its
    contributors may be used to endorse or promote products derived
    from this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
"AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT
OWNER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

### Unicode License v3 (1 of 2)

- `icu_collections` 2.4.0 (apple, android): Copyright © 2020-2024 Unicode, Inc.
- `icu_locale_core` 2.4.0 (apple, android): Copyright © 2020-2024 Unicode, Inc.
- `icu_normalizer` 2.4.0 (apple, android): Copyright © 2020-2024 Unicode, Inc.
- `icu_normalizer_data` 2.4.0 (apple, android): Copyright © 2020-2024 Unicode, Inc.
- `icu_properties` 2.4.0 (apple, android): Copyright © 2020-2024 Unicode, Inc.
- `icu_properties_data` 2.4.0 (apple, android): Copyright © 2020-2024 Unicode, Inc.
- `icu_provider` 2.4.0 (apple, android): Copyright © 2020-2024 Unicode, Inc.
- `litemap` 0.8.3 (apple, android): Copyright © 2020-2024 Unicode, Inc.
- `potential_utf` 0.1.6 (apple, android): Copyright © 2020-2024 Unicode, Inc.
- `tinystr` 0.8.5 (apple, android): Copyright © 2020-2024 Unicode, Inc.
- `writeable` 0.6.4 (apple, android): Copyright © 2020-2024 Unicode, Inc.
- `yoke` 0.8.4 (apple, android): Copyright © 2020-2024 Unicode, Inc.
- `zerofrom` 0.1.8 (apple, android): Copyright © 2020-2024 Unicode, Inc.
- `zerotrie` 0.2.5 (apple, android): Copyright © 2020-2024 Unicode, Inc.
- `zerovec` 0.11.9 (apple, android): Copyright © 2020-2024 Unicode, Inc.

```
UNICODE LICENSE V3

COPYRIGHT AND PERMISSION NOTICE

NOTICE TO USER: Carefully read the following legal agreement. BY
DOWNLOADING, INSTALLING, COPYING OR OTHERWISE USING DATA FILES, AND/OR
SOFTWARE, YOU UNEQUIVOCALLY ACCEPT, AND AGREE TO BE BOUND BY, ALL OF THE
TERMS AND CONDITIONS OF THIS AGREEMENT. IF YOU DO NOT AGREE, DO NOT
DOWNLOAD, INSTALL, COPY, DISTRIBUTE OR USE THE DATA FILES OR SOFTWARE.

Permission is hereby granted, free of charge, to any person obtaining a
copy of data files and any associated documentation (the "Data Files") or
software and any associated documentation (the "Software") to deal in the
Data Files or Software without restriction, including without limitation
the rights to use, copy, modify, merge, publish, distribute, and/or sell
copies of the Data Files or Software, and to permit persons to whom the
Data Files or Software are furnished to do so, provided that either (a)
this copyright and permission notice appear with all copies of the Data
Files or Software, or (b) this copyright and permission notice appear in
associated Documentation.

THE DATA FILES AND SOFTWARE ARE PROVIDED "AS IS", WITHOUT WARRANTY OF ANY
KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT OF
THIRD PARTY RIGHTS.

IN NO EVENT SHALL THE COPYRIGHT HOLDER OR HOLDERS INCLUDED IN THIS NOTICE
BE LIABLE FOR ANY CLAIM, OR ANY SPECIAL INDIRECT OR CONSEQUENTIAL DAMAGES,
OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS,
WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION,
ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THE DATA
FILES OR SOFTWARE.

Except as contained in this notice, the name of a copyright holder shall
not be used in advertising or otherwise to promote the sale, use or other
dealings in these Data Files or Software without prior written
authorization of the copyright holder.

SPDX-License-Identifier: Unicode-3.0

—

Portions of ICU4X may have been adapted from ICU4C and/or ICU4J.
ICU 1.8.1 to ICU 57.1 © 1995-2016 International Business Machines Corporation and others.
```

### Unicode License v3 (2 of 2)

- `unicode-ident` 1.0.27 (web, webgl, apple, android): Copyright © 1991-2023 Unicode, Inc.

```
UNICODE LICENSE V3

COPYRIGHT AND PERMISSION NOTICE

NOTICE TO USER: Carefully read the following legal agreement. BY
DOWNLOADING, INSTALLING, COPYING OR OTHERWISE USING DATA FILES, AND/OR
SOFTWARE, YOU UNEQUIVOCALLY ACCEPT, AND AGREE TO BE BOUND BY, ALL OF THE
TERMS AND CONDITIONS OF THIS AGREEMENT. IF YOU DO NOT AGREE, DO NOT
DOWNLOAD, INSTALL, COPY, DISTRIBUTE OR USE THE DATA FILES OR SOFTWARE.

Permission is hereby granted, free of charge, to any person obtaining a
copy of data files and any associated documentation (the "Data Files") or
software and any associated documentation (the "Software") to deal in the
Data Files or Software without restriction, including without limitation
the rights to use, copy, modify, merge, publish, distribute, and/or sell
copies of the Data Files or Software, and to permit persons to whom the
Data Files or Software are furnished to do so, provided that either (a)
this copyright and permission notice appear with all copies of the Data
Files or Software, or (b) this copyright and permission notice appear in
associated Documentation.

THE DATA FILES AND SOFTWARE ARE PROVIDED "AS IS", WITHOUT WARRANTY OF ANY
KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT OF
THIRD PARTY RIGHTS.

IN NO EVENT SHALL THE COPYRIGHT HOLDER OR HOLDERS INCLUDED IN THIS NOTICE
BE LIABLE FOR ANY CLAIM, OR ANY SPECIAL INDIRECT OR CONSEQUENTIAL DAMAGES,
OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS,
WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION,
ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THE DATA
FILES OR SOFTWARE.

Except as contained in this notice, the name of a copyright holder shall
not be used in advertising or otherwise to promote the sale, use or other
dealings in these Data Files or Software without prior written
authorization of the copyright holder.
```

<!-- END rust-crates -->
