# Changelog

## [0.7.1](https://github.com/tektum/procella/compare/procella-v0.7.0...procella-v0.7.1) (2026-09-16)


### Bug Fixes

* **actions:** correct backend URL and add ESC action ([#320](https://github.com/tektum/procella/issues/320)) ([a6e192f](https://github.com/tektum/procella/commit/a6e192f03c933aa2d9ac4fac0c809bb7ab5ac5f4))
* **migrate:** detect unknown state loss during verification ([#322](https://github.com/tektum/procella/issues/322)) ([49405b9](https://github.com/tektum/procella/commit/49405b9425e3ce39b85d5fea7e844b93a1c0532e))

## [0.7.0](https://github.com/tektum/procella/compare/procella-v0.6.0...procella-v0.7.0) (2026-09-10)


### Features

* **oidc:** streamline GitHub Actions setup ([#316](https://github.com/tektum/procella/issues/316)) ([5eadbb7](https://github.com/tektum/procella/commit/5eadbb703d3a066e62c41cfcdafd9a13827b1d98))
* support multiple GitHub Actions OIDC repositories ([#318](https://github.com/tektum/procella/issues/318)) ([a3bfa1d](https://github.com/tektum/procella/commit/a3bfa1d7b0d98f190028a28f18a57e975a14696d))


### Bug Fixes

* remove Procella GitHub update publication ([#319](https://github.com/tektum/procella/issues/319)) ([2f1206b](https://github.com/tektum/procella/commit/2f1206b05690336881f7078b5de61f569041922d))

## [0.6.0](https://github.com/tektum/procella/compare/procella-v0.5.0...procella-v0.6.0) (2026-09-08)


### Features

* **github:** bind installations to authenticated tenants ([#258](https://github.com/tektum/procella/issues/258)) ([76b9df1](https://github.com/tektum/procella/commit/76b9df1c6f4a049c0fcd2e39718692f016afbeb4))
* **github:** connect installations from a listed account ([#313](https://github.com/tektum/procella/issues/313)) ([d5d4e8b](https://github.com/tektum/procella/commit/d5d4e8b08140046d1fbcdbc3b6386380f5e3e0e4))
* **github:** publish updates through durable outbox ([#262](https://github.com/tektum/procella/issues/262)) ([e8d7792](https://github.com/tektum/procella/commit/e8d7792992bb8558d66f7e30072aa88b9e597431))
* **github:** verify installs through a Descope Outbound App ([#308](https://github.com/tektum/procella/issues/308)) ([f78c8d8](https://github.com/tektum/procella/commit/f78c8d88a12ec4bac275d0f2ed6d4a4f3c97a61e))


### Bug Fixes

* **api:** bind subscription tickets to their procedure and resource ([#271](https://github.com/tektum/procella/issues/271)) ([65188d9](https://github.com/tektum/procella/commit/65188d9efae026cefb54f848dfccb2ab8f633e96))
* **api:** consume subscription tickets atomically ([#295](https://github.com/tektum/procella/issues/295)) ([fdc5ccd](https://github.com/tektum/procella/commit/fdc5ccd2c9f2a28a5c98e6af0ab80141af57bd3c))
* **api:** guard repair against a stale source checkpoint ([#283](https://github.com/tektum/procella/issues/283)) ([9581b2e](https://github.com/tektum/procella/commit/9581b2e74c0bd03bdad1367a55bf047bd7f00ff0))
* **api:** map domain errors and stop leaking error internals over tRPC ([#272](https://github.com/tektum/procella/issues/272)) ([5c6d28f](https://github.com/tektum/procella/commit/5c6d28f95156d6c2f1d0916efd762c7ed901bcec))
* **api:** multiplex dashboard subscriptions over shared listeners ([#304](https://github.com/tektum/procella/issues/304)) ([a4418d4](https://github.com/tektum/procella/commit/a4418d4ebf11966386d9a3ece84f85fe19214ce1))
* **auth:** enforce role checks on stack, update, state, crypto, and ESC routes ([#282](https://github.com/tektum/procella/issues/282)) ([33eefa9](https://github.com/tektum/procella/commit/33eefa9e78b67bc04367db1e242fbf81fc9825f2))
* **auth:** reject replayed access-key bearer tokens ([#299](https://github.com/tektum/procella/issues/299)) ([8223325](https://github.com/tektum/procella/commit/82233252ac7119a0d7cfd6bfba4a109e7b4b28e1))
* **auth:** restrict CLI token minting to interactive session principals ([#273](https://github.com/tektum/procella/issues/273)) ([e2113ca](https://github.com/tektum/procella/commit/e2113ca3140d7d1817b4d681d5aa4483467edf39))
* **ci:** execute the silently skipped ESC and OIDC suites ([#287](https://github.com/tektum/procella/issues/287)) ([544f4d9](https://github.com/tektum/procella/commit/544f4d937d053bb60e6e05b6a86301aa1b4c86ec))
* **ci:** make preview cleanup idempotent ([#267](https://github.com/tektum/procella/issues/267)) ([8ee627e](https://github.com/tektum/procella/commit/8ee627e9805980ea8d54e513e85d3deca24980c8))
* **ci:** remove privileged token exposure from Renovate config validation ([#280](https://github.com/tektum/procella/issues/280)) ([bb9d860](https://github.com/tektum/procella/commit/bb9d860f78b47ba9c3ef69a7294639fb17516d41))
* **ci:** retry stalled dependency audits ([#268](https://github.com/tektum/procella/issues/268)) ([af04c3c](https://github.com/tektum/procella/commit/af04c3cc85ecbfdf1bab472df9c4c273bced4663))
* **crypto:** derive legacy key identity from the resolved stack row ([#292](https://github.com/tektum/procella/issues/292)) ([314c9b4](https://github.com/tektum/procella/commit/314c9b4a7f26b4fc3cbc6fcc3edb0b8d577a0d3d))
* **db:** serialize schema migrations with an advisory lock ([#269](https://github.com/tektum/procella/issues/269)) ([c488a50](https://github.com/tektum/procella/commit/c488a507b61698095ca115a9da488c13287370b7))
* **deploy:** correct container and blueprint startup contracts ([#290](https://github.com/tektum/procella/issues/290)) ([5d7e0d8](https://github.com/tektum/procella/commit/5d7e0d8a2e2d500df7b3168999783fae489114bc))
* **deps:** update aws-sdk-go-v2 monorepo ([#265](https://github.com/tektum/procella/issues/265)) ([f740528](https://github.com/tektum/procella/commit/f740528d79c62032c33044163ef98413bdd848c3))
* **esc:** reject ambient credential ESC provider definitions ([#275](https://github.com/tektum/procella/issues/275)) ([3969d7e](https://github.com/tektum/procella/commit/3969d7e685ba09e42b2af94f5069a7fc8bc79b60))
* **esc:** serialize revision writes and draft transitions ([#288](https://github.com/tektum/procella/issues/288)) ([ac4bfbf](https://github.com/tektum/procella/commit/ac4bfbf726ccdd38ee780b57a534004f6d921f85))
* **github:** address connect-list review findings ([#314](https://github.com/tektum/procella/issues/314)) ([d0d3351](https://github.com/tektum/procella/commit/d0d3351af2d7c661334055879542081ea8ab2c2e))
* **github:** derive app slug from credentials ([#263](https://github.com/tektum/procella/issues/263)) ([17dc3e4](https://github.com/tektum/procella/commit/17dc3e44e69398b4057deb89fd526d50981decd6))
* **github:** harden installation binding against cross-tenant claims ([#293](https://github.com/tektum/procella/issues/293)) ([6e54afc](https://github.com/tektum/procella/commit/6e54afc3037f8434a0b59e70753ed7b1e8532007))
* **github:** make SST App secrets optional ([#264](https://github.com/tektum/procella/issues/264)) ([027ee41](https://github.com/tektum/procella/commit/027ee41cbc3ac4e6bed53a28eba4385cd9591ed6))
* **github:** use cookie-mode outbound connect ([#310](https://github.com/tektum/procella/issues/310)) ([441ca32](https://github.com/tektum/procella/commit/441ca3240524c269d772723e8d9ada6adcd89dbe))
* **infra:** keep executable provisioner out of SST bundle ([#309](https://github.com/tektum/procella/issues/309)) ([5fae3c6](https://github.com/tektum/procella/commit/5fae3c6e0cbc647d4b2d22e5b7ae284596ff523f))
* **infra:** resolve outbound provisioner source path ([#311](https://github.com/tektum/procella/issues/311)) ([4593c01](https://github.com/tektum/procella/commit/4593c01340449b1fa7d269e02fb1648e66c9bf54))
* **migrate:** reject cross-org target identity collisions ([#300](https://github.com/tektum/procella/issues/300)) ([7dafb2f](https://github.com/tektum/procella/commit/7dafb2f55d2afc03ed72f206af3be3e9b451eb03))
* **migrate:** reserialize secrets through the target secret provider ([#284](https://github.com/tektum/procella/issues/284)) ([a9be027](https://github.com/tektum/procella/commit/a9be02787ea990afc3611d3b0d2031414031c314))
* **migrate:** verify complete logical deployment state ([#303](https://github.com/tektum/procella/issues/303)) ([106d34f](https://github.com/tektum/procella/commit/106d34f593c65afef0fb8e728cab7d64fe681a36))
* **oidc:** enforce global trust policy ownership ([#266](https://github.com/tektum/procella/issues/266)) ([3796c4f](https://github.com/tektum/procella/commit/3796c4f3160fab78a460be419247f27a6da1ff0c))
* **oidc:** stage tenant-safe trust policy ownership ([#260](https://github.com/tektum/procella/issues/260)) ([c5c3665](https://github.com/tektum/procella/commit/c5c3665774792d172651fd076770b2de3da53b49))
* **server:** authenticate before decompressing request bodies ([#291](https://github.com/tektum/procella/issues/291)) ([98e8787](https://github.com/tektum/procella/commit/98e87875dd84e164dfec0eabb65a3f4c49172e8b))
* **server:** let cookie-authenticated requests reach the authenticator ([#277](https://github.com/tektum/procella/issues/277)) ([af9ad81](https://github.com/tektum/procella/commit/af9ad811d1a79293bf98ec62f41884f65c8232e9))
* **server:** restore pre-auth CLI token rate limiting ([#301](https://github.com/tektum/procella/issues/301)) ([3923132](https://github.com/tektum/procella/commit/392313287db7b3227d31b85f66295433d84f09c7))
* **server:** validate imported deployment payloads structurally ([#276](https://github.com/tektum/procella/issues/276)) ([7753b73](https://github.com/tektum/procella/commit/7753b73ab1a068bda4c693de0390bf333d58528e))
* **stacks:** durably clean deleted stack state ([#294](https://github.com/tektum/procella/issues/294)) ([216240e](https://github.com/tektum/procella/commit/216240e1bc539355c72b74a0de171e26db7c46f1))
* **stacks:** lock and guard stack deletion ([#278](https://github.com/tektum/procella/issues/278)) ([0170d49](https://github.com/tektum/procella/commit/0170d492a33e37e88df3d426213353f16bb0b859))
* **storage:** forward AWS session tokens to the S3 client ([#270](https://github.com/tektum/procella/issues/270)) ([c19e30e](https://github.com/tektum/procella/commit/c19e30ecf80222f72e293c02808672ca29229aae))
* **telemetry:** harden database error projection ([#298](https://github.com/tektum/procella/issues/298)) ([717040f](https://github.com/tektum/procella/commit/717040f3f3bf9de6683f5607669e9e65a13c0164))
* **telemetry:** redact database parameters from logs, spans, and errors ([#285](https://github.com/tektum/procella/issues/285)) ([9afcf97](https://github.com/tektum/procella/commit/9afcf9799ff783e68a91703a4202ef5963654233))
* **updates:** emit terminal webhooks for update-token completions ([#279](https://github.com/tektum/procella/issues/279)) ([a412597](https://github.com/tektum/procella/commit/a412597642fe6795cfcd6e35432880c525b49980))
* **updates:** propagate one-shot GC failures ([#289](https://github.com/tektum/procella/issues/289)) ([cb56473](https://github.com/tektum/procella/commit/cb5647357268e0a4d214fb47063e6b752028ec50))
* **updates:** reject non-terminal update completion status ([#286](https://github.com/tektum/procella/issues/286)) ([ef8486d](https://github.com/tektum/procella/commit/ef8486dc9e972b100723a92f49b7d6b923d43d28))
* **updates:** resolve historical export by stack update version ([#274](https://github.com/tektum/procella/issues/274)) ([796bf1d](https://github.com/tektum/procella/commit/796bf1d861e40f385e1d1d744a9f8bdeab7e2873))
* **updates:** validate all deployment import paths ([#296](https://github.com/tektum/procella/issues/296)) ([15b10cf](https://github.com/tektum/procella/commit/15b10cff0421f50a09cc9a43027d6d36f70c774c))
* **webhooks:** persist delivery intents transactionally ([#297](https://github.com/tektum/procella/issues/297)) ([e30a25d](https://github.com/tektum/procella/commit/e30a25d96c3a1f52d7bfb0406a45b95685ac45d9))
* **webhooks:** restrict outbound destinations to global unicast addresses ([#281](https://github.com/tektum/procella/issues/281)) ([4d33798](https://github.com/tektum/procella/commit/4d3379823a46b4054c5853a8809b073a758e93db))

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
