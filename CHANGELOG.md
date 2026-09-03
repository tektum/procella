# Changelog

## [0.5.0](https://github.com/tektum/procella/compare/procella-v0.4.0...procella-v0.5.0) (2026-09-03)


### Features

* **actions:** add Procella OIDC authentication ([#255](https://github.com/tektum/procella/issues/255)) ([ab56d05](https://github.com/tektum/procella/commit/ab56d05b6366e8fbb3cfc7381bc77b66b071211d))
* **actions:** add Procella Pulumi GitHub Action ([#246](https://github.com/tektum/procella/issues/246)) ([e036a1d](https://github.com/tektum/procella/commit/e036a1df5937e4ffc351c2fc47b5ea743b7f782e))
* establish Pulumi CLI compatibility policy ([#253](https://github.com/tektum/procella/issues/253)) ([ea37938](https://github.com/tektum/procella/commit/ea3793847014c57714c12ccd7899ae00d6185a86))


### Bug Fixes

* **api:** correct deployment-schema-version capability wire shape ([#244](https://github.com/tektum/procella/issues/244)) ([064d194](https://github.com/tektum/procella/commit/064d1949994a6611ef174f8732f2f96364d3f7b9))
* **ci:** isolate pull request concurrency from push runs ([#243](https://github.com/tektum/procella/issues/243)) ([38d245b](https://github.com/tektum/procella/commit/38d245b4b19b08feb7ac9e275d740ea8859a1d8d))
* **deps:** update dependency @descope/react-sdk to v3 ([#227](https://github.com/tektum/procella/issues/227)) ([87bd3fb](https://github.com/tektum/procella/commit/87bd3fbdde6acd36c0fe70556e75ebd788a48bee))
* **github:** derive PR context from update metadata ([#252](https://github.com/tektum/procella/issues/252)) ([1ceda81](https://github.com/tektum/procella/commit/1ceda8100a1e3f6a0e879f59ee65b6f63352e1ba))
* **infra:** route ESC web requests to API ([#247](https://github.com/tektum/procella/issues/247)) ([dd4a8ef](https://github.com/tektum/procella/commit/dd4a8efe9b1f4f7c279e5b653e393dd8bf9e63fe))
* **updates:** preserve numeric permalink identity ([#256](https://github.com/tektum/procella/issues/256)) ([0f402d1](https://github.com/tektum/procella/commit/0f402d14f4e33b5d315bcda2fa2bfcb1a38dad03))

## [0.4.0](https://github.com/tektum/procella/compare/procella-v0.3.4...procella-v0.4.0) (2026-09-02)


### Features

* **ci:** add deployment safety checks ([#235](https://github.com/tektum/procella/issues/235)) ([5951302](https://github.com/tektum/procella/commit/5951302dfc358dbf0716118ce1ac9dec78fa6532))


### Bug Fixes

* **auth:** source UI roles from verified caller ([#240](https://github.com/tektum/procella/issues/240)) ([afe88e8](https://github.com/tektum/procella/commit/afe88e878efc867f9d58e41d14d5b5d0d81ee11e))
* **ci:** preserve historical deployment refs ([#238](https://github.com/tektum/procella/issues/238)) ([8ea94fb](https://github.com/tektum/procella/commit/8ea94fb440b88525407cb7e99b0b9e183bfee9a7))
* resolve ESC creator identity display ([#232](https://github.com/tektum/procella/issues/232)) ([cd8c345](https://github.com/tektum/procella/commit/cd8c345b198aee6ba23820094eff8b91b5efa068))

## [0.3.4](https://github.com/tektum/procella/compare/procella-v0.3.3...procella-v0.3.4) (2026-09-01)


### Bug Fixes

* **ci:** build ESC bootstrap in reusable deploy ([#233](https://github.com/tektum/procella/issues/233)) ([b595376](https://github.com/tektum/procella/commit/b595376908161b3f55d06a4cfdb4b4d7f41a442a))

## [0.3.3](https://github.com/tektum/procella/compare/procella-v0.3.2...procella-v0.3.3) (2026-09-01)


### Bug Fixes

* **ci:** configure deployment AWS region ([#218](https://github.com/tektum/procella/issues/218)) ([1e2c18c](https://github.com/tektum/procella/commit/1e2c18cbee8d3c2588eee942e16de19db8aec059))
* **ci:** correct mise action version comments ([#222](https://github.com/tektum/procella/issues/222)) ([bbb2d4e](https://github.com/tektum/procella/commit/bbb2d4eceb1e328201af7c94865d7091c7374b91))
* **deps:** update aws-sdk-go-v2 monorepo ([#211](https://github.com/tektum/procella/issues/211)) ([2b8adc1](https://github.com/tektum/procella/commit/2b8adc14db468cee21e6200e39246507ea3c29f8))
* **deps:** update aws-sdk-go-v2 monorepo ([#226](https://github.com/tektum/procella/issues/226)) ([72516cb](https://github.com/tektum/procella/commit/72516cb8273bbaca0804a212b25860fc7f35dfb0))
* **deps:** update aws-sdk-go-v2 monorepo ([#228](https://github.com/tektum/procella/issues/228)) ([3ffa926](https://github.com/tektum/procella/commit/3ffa926a4e4f2221947d4364ad8462cfb8ba45ee))
* **deps:** update dependency @opentelemetry/otlp-transformer to ^0.221.0 ([#215](https://github.com/tektum/procella/issues/215)) ([d7457a9](https://github.com/tektum/procella/commit/d7457a971703085e0ea8ee2b1c015fedb2b2f8c0))
* **updates:** preserve Pulumi journal dependency order ([#230](https://github.com/tektum/procella/issues/230)) ([b9408f8](https://github.com/tektum/procella/commit/b9408f826b8b21d0ffcf8eb000f6346fd5d38b98))

## [0.3.2](https://github.com/procella-dev/procella/compare/procella-v0.3.1...procella-v0.3.2) (2026-07-13)


### Bug Fixes

* **ci:** restore production release deploy ([#209](https://github.com/procella-dev/procella/issues/209)) ([4d2fd4b](https://github.com/procella-dev/procella/commit/4d2fd4b121f3d7a0843e6c44cb91165627b55fee))
* **deps:** update module github.com/pulumi/esc to v0.26.0 ([#206](https://github.com/procella-dev/procella/issues/206)) ([3ed3428](https://github.com/procella-dev/procella/commit/3ed3428665dd8df938e982afe48735049b267040))

## [0.3.1](https://github.com/procella-dev/procella/compare/procella-v0.3.0...procella-v0.3.1) (2026-07-13)


### Bug Fixes

* **deps:** update aws-sdk-go-v2 monorepo ([#202](https://github.com/procella-dev/procella/issues/202)) ([57b5fe9](https://github.com/procella-dev/procella/commit/57b5fe907d65f4f428fcbb32b38b7792b95cc8dd))
* **deps:** update dependency react-router to v8 ([#201](https://github.com/procella-dev/procella/issues/201)) ([440e53f](https://github.com/procella-dev/procella/commit/440e53fadeacdd5776f06b66ced1e9516dd3d4b9))

## [0.3.0](https://github.com/procella-dev/procella/compare/procella-v0.2.0...procella-v0.3.0) (2026-07-07)


### Features

* **migrate:** add @procella/migrate CLI tool, migration docs, and release pipeline ([#123](https://github.com/procella-dev/procella/issues/123)) ([d5e0f7c](https://github.com/procella-dev/procella/commit/d5e0f7c50f274894f1738f2a4c1d0dde5825ed4a))


### Bug Fixes

* **auth:** use Descope HttpOnly cookie auth ([#199](https://github.com/procella-dev/procella/issues/199)) ([4dd3179](https://github.com/procella-dev/procella/commit/4dd31792321d67fd737435f373c4c8f4ab2a3260))
* **ci:** isolate release jobs by component ([#188](https://github.com/procella-dev/procella/issues/188)) ([b4873a8](https://github.com/procella-dev/procella/commit/b4873a8e26c5e4320edcffcf5521c126faf58215))
* **ci:** remove invalid release-please lockfile path ([#181](https://github.com/procella-dev/procella/issues/181)) ([15e25c2](https://github.com/procella-dev/procella/commit/15e25c2f2c00afa7b18ddbd8ce09b1f863047ecc))
* **ci:** split release-please component PRs ([#185](https://github.com/procella-dev/procella/issues/185)) ([31d45da](https://github.com/procella-dev/procella/commit/31d45dadd4b54baccae1a99123681dbc36b8152e))
* **deps:** update aws-sdk-go-v2 monorepo ([#193](https://github.com/procella-dev/procella/issues/193)) ([1dac751](https://github.com/procella-dev/procella/commit/1dac751b93146fa3873009224ced6c1b29dc145c))
* **deps:** update dependency @opentelemetry/otlp-transformer to ^0.220.0 ([#196](https://github.com/procella-dev/procella/issues/196)) ([adac743](https://github.com/procella-dev/procella/commit/adac743d8fe7f3e6bde74cc4917e4af30ff59b5a))
* **deps:** update module github.com/pulumi/pulumi/sdk/v3 to v3.250.0 ([#197](https://github.com/procella-dev/procella/issues/197)) ([d378b48](https://github.com/procella-dev/procella/commit/d378b4817cffdb68713923ecbf6d5e4e9b435e6a))
* **infra:** wire GitHub app secrets into SST ([#184](https://github.com/procella-dev/procella/issues/184)) ([6506585](https://github.com/procella-dev/procella/commit/65065855ec03176f36d2da6e903fa8969760766a))
* **ui:** dashboard polish — command bar search, mobile nav, honest stack rows, duration rollup ([#195](https://github.com/procella-dev/procella/issues/195)) ([5f3ef0b](https://github.com/procella-dev/procella/commit/5f3ef0bbf923130870ce27d1afc85c6763df7b43))

## [0.2.0](https://github.com/procella-dev/procella/compare/procella-v0.1.0...procella-v0.2.0) (2026-06-29)


### Features

* add release-please + dev stage, decouple prod deploy from main ([#124](https://github.com/procella-dev/procella/issues/124)) ([f99a6b0](https://github.com/procella-dev/procella/commit/f99a6b0d16586b83569521b9bd8f5c0f6b7a4284))
* **esc:** full Pulumi ESC equivalent — backend, evaluator, providers, UI (procella-yj7 epic) ([#140](https://github.com/procella-dev/procella/issues/140)) ([048989b](https://github.com/procella-dev/procella/commit/048989b24bd805fd5ad4bb06811efa1edb1312d9))


### Bug Fixes

* add @trpc/server to root devDeps to ensure hoisting ([#134](https://github.com/procella-dev/procella/issues/134)) ([8f0f993](https://github.com/procella-dev/procella/commit/8f0f99322dc09451e0449e921dabd67545c8b12a))
* **ci:** preserve Descope OIDC org slug ([#172](https://github.com/procella-dev/procella/issues/172)) ([5e3625d](https://github.com/procella-dev/procella/commit/5e3625dadeacbef07af9533e54e4c6df19594302))
* declare phantom dependencies and update biome to 2.4.12 ([#133](https://github.com/procella-dev/procella/issues/133)) ([ecb7a9b](https://github.com/procella-dev/procella/commit/ecb7a9bacddadc190a5e25fb83b01a3ffe661c26))
* **deps:** pin astro's vite to ^7 (scoped override) ([#155](https://github.com/procella-dev/procella/issues/155)) ([4ccdee1](https://github.com/procella-dev/procella/commit/4ccdee108fa22665186b2cd39c7f13eb6dc57059))
* **deps:** update aws-sdk-go-v2 monorepo ([#152](https://github.com/procella-dev/procella/issues/152)) ([90e902d](https://github.com/procella-dev/procella/commit/90e902d3e11f8c0a494003620a7a2477d08d138b))
* **deps:** update aws-sdk-go-v2 monorepo ([#168](https://github.com/procella-dev/procella/issues/168)) ([6e44e16](https://github.com/procella-dev/procella/commit/6e44e16b8cc729fb8fce5182969bef8639b5433f))
* **deps:** update dependency @astrojs/starlight to ^0.39.0 ([#159](https://github.com/procella-dev/procella/issues/159)) ([2cf5533](https://github.com/procella-dev/procella/commit/2cf553357b23f37d32975660c289e3c0bdfaf3b6))
* **deps:** update dependency @astrojs/starlight to ^0.41.0 ([#174](https://github.com/procella-dev/procella/issues/174)) ([d387364](https://github.com/procella-dev/procella/commit/d387364047bb36f58113d90089bdf3f4c9ff6d3d))
* **deps:** update dependency @opentelemetry/otlp-transformer to ^0.215.0 ([#137](https://github.com/procella-dev/procella/issues/137)) ([6833255](https://github.com/procella-dev/procella/commit/683325584d9577a0455b61a6bb9965cae8365ad1))
* **deps:** update dependency @opentelemetry/otlp-transformer to ^0.216.0 ([#153](https://github.com/procella-dev/procella/issues/153)) ([337df2f](https://github.com/procella-dev/procella/commit/337df2f3042d7525134d5a6f415c7e0af28cddc0))
* **deps:** update dependency @opentelemetry/otlp-transformer to ^0.217.0 ([#158](https://github.com/procella-dev/procella/issues/158)) ([2c36919](https://github.com/procella-dev/procella/commit/2c3691999cf68cf9bca262917de6b424232fb77b))
* **deps:** update dependency @opentelemetry/otlp-transformer to ^0.218.0 ([#165](https://github.com/procella-dev/procella/issues/165)) ([634682c](https://github.com/procella-dev/procella/commit/634682c1c310b580f381086834884213700bb3f4))
* **deps:** update dependency @opentelemetry/otlp-transformer to ^0.219.0 ([#176](https://github.com/procella-dev/procella/issues/176)) ([a8cf19c](https://github.com/procella-dev/procella/commit/a8cf19c180b8350b362d318bab71bed18ee033b5))
* **deps:** update dependency sharp to ^0.35.0 ([#177](https://github.com/procella-dev/procella/issues/177)) ([e9e806d](https://github.com/procella-dev/procella/commit/e9e806d9eb145c7d72770e0cd0fe188106d527bf))
* **deps:** update module github.com/aws/aws-lambda-go to v1.54.0 ([#145](https://github.com/procella-dev/procella/issues/145)) ([2a74ea8](https://github.com/procella-dev/procella/commit/2a74ea83a8d0e449699bb6748efd29ae44f70a56))
* **deps:** update module github.com/pulumi/esc to v0.25.0 ([#169](https://github.com/procella-dev/procella/issues/169)) ([ed2ed4c](https://github.com/procella-dev/procella/commit/ed2ed4c9f43612bd956ac31b1212d809d15787b6))
* **deps:** update module github.com/pulumi/pulumi/sdk/v3 to v3.230.0 ([#118](https://github.com/procella-dev/procella/issues/118)) ([bfc7314](https://github.com/procella-dev/procella/commit/bfc73142c966feec086425e61b3cded505556021))
* **deps:** update module github.com/pulumi/pulumi/sdk/v3 to v3.232.0 ([#136](https://github.com/procella-dev/procella/issues/136)) ([5cddbb3](https://github.com/procella-dev/procella/commit/5cddbb30b1b8810fc82ad50b229ba74dc16b3cc3))
* **deps:** update module github.com/pulumi/pulumi/sdk/v3 to v3.237.0 ([#156](https://github.com/procella-dev/procella/issues/156)) ([272797c](https://github.com/procella-dev/procella/commit/272797ce29bf1a25d51d89b8b9e369c49800c348))
* **deps:** update module github.com/pulumi/pulumi/sdk/v3 to v3.247.0 ([#166](https://github.com/procella-dev/procella/issues/166)) ([94d7649](https://github.com/procella-dev/procella/commit/94d76496c65c7b6bfdc01a5d6609ddfd5047ce8e))
* **deps:** update module github.com/pulumi/pulumi/sdk/v3 to v3.248.0 ([#178](https://github.com/procella-dev/procella/issues/178)) ([0605309](https://github.com/procella-dev/procella/commit/06053099a8bb351f5b00ad18dd1e01cc2188550d))
* **e2e:** warm up server to reduce sharded cold-start flakes ([#142](https://github.com/procella-dev/procella/issues/142)) ([f78f3e6](https://github.com/procella-dev/procella/commit/f78f3e65e9a424026193405cae93df9528705019))
* **infra:** pass new required env vars to API + WebApi Lambdas (preview broken) ([#151](https://github.com/procella-dev/procella/issues/151)) ([84ff566](https://github.com/procella-dev/procella/commit/84ff566cadb62a71722e8a344969f7c5590243b4))
* **oidc:** retire stale cross-tenant policies ([#175](https://github.com/procella-dev/procella/issues/175)) ([9dd6efe](https://github.com/procella-dev/procella/commit/9dd6efea2fe3cef3e04685f0792db0229a0abed0))
* pin @trpc/server to ~11.12.0 and group tRPC updates ([#135](https://github.com/procella-dev/procella/issues/135)) ([5b5a12f](https://github.com/procella-dev/procella/commit/5b5a12fa0d0bde1ad76199bc6353bde69a63a08b))
* pin bun install to hoisted layout to avoid TS2742 on isolated installs ([#144](https://github.com/procella-dev/procella/issues/144)) ([5e881c3](https://github.com/procella-dev/procella/commit/5e881c3748848928f0f88de64d18eacf23e183a1))
* **renovate:** drop Docker, run Renovate directly on runner ([#131](https://github.com/procella-dev/procella/issues/131)) ([a082c96](https://github.com/procella-dev/procella/commit/a082c96de53a93775c43ad004fde2bee6afe83f4))
* **renovate:** mount bun binary directly into Docker container ([#130](https://github.com/procella-dev/procella/issues/130)) ([1cf1122](https://github.com/procella-dev/procella/commit/1cf1122aafac65112234673ff2e44fcb112ad5ff))
* **renovate:** regenerate bun.lock on dependency updates ([#129](https://github.com/procella-dev/procella/issues/129)) ([5478e14](https://github.com/procella-dev/procella/commit/5478e1418f95e578508185508ee71f3691f451ae))
* **server:** accept Pulumi API version 9 (CLI v3.233+) ([#160](https://github.com/procella-dev/procella/issues/160)) ([8c1d6a5](https://github.com/procella-dev/procella/commit/8c1d6a5fbf3bfb13f5a24fb023d1fdca02a08a56))
* **server:** allow large batch crypt requests ([#171](https://github.com/procella-dev/procella/issues/171)) ([a2a917e](https://github.com/procella-dev/procella/commit/a2a917ee90b39618f1fbbe174a45bc235c99442f))
* **server:** retry transient PG conflicts as 503 (procella-fkf) ([#150](https://github.com/procella-dev/procella/issues/150)) ([2d57ccc](https://github.com/procella-dev/procella/commit/2d57ccc35a1d8f443af0dd00e9f40f6b49042264))


### Performance Improvements

* **ci:** adopt Bun 1.3.13 --parallel (unit) and --shard (e2e) ([#141](https://github.com/procella-dev/procella/issues/141)) ([8a3b072](https://github.com/procella-dev/procella/commit/8a3b0721c67d99846481ded3f76af905e5ebbf76))
* **ui:** lazy-load route components to drop main bundle below 500 kB ([#143](https://github.com/procella-dev/procella/issues/143)) ([d52529d](https://github.com/procella-dev/procella/commit/d52529daa00cd90a9fd5d8038d526c3b392a3b35))
