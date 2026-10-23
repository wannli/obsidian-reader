# Changelog

## [0.16.0](https://github.com/wannli/obsidian-reader/compare/0.15.1...0.16.0) (2026-10-23)


### Added

* **reader:** create linked nodes from tap-selected passages ([0f045fc](https://github.com/wannli/obsidian-reader/commit/0f045fc84c5a780695499745a65b151c7f2de09a))


### Fixed

* **highlights:** hide article and feed classes from note picker ([62b2a3a](https://github.com/wannli/obsidian-reader/commit/62b2a3a8f469246e2ba5283dbe00b5c3ed811ad9))

## [0.15.1](https://github.com/wannli/obsidian-reader/compare/0.15.0...0.15.1) (2026-10-22)


### Fixed

* **capture:** use multiline URL input for bulk articles ([#46](https://github.com/wannli/obsidian-reader/issues/46)) ([7c57556](https://github.com/wannli/obsidian-reader/commit/7c57556e67a2ecd0e9dd9be1461e8962e0ef87ed))

## [0.15.0](https://github.com/wannli/obsidian-reader/compare/0.14.0...0.15.0) (2026-10-22)


### Added

* **capture:** add bulk CSV article import command ([#44](https://github.com/wannli/obsidian-reader/issues/44)) ([e87c67b](https://github.com/wannli/obsidian-reader/commit/e87c67b81ba12b07e9006bef33e6e8e82a199536))

## [0.14.0](https://github.com/wannli/obsidian-reader/compare/0.13.1...0.14.0) (2026-10-21)


### Added

* **highlights:** model native hosted highlights and quotation snapshots ([81894dd](https://github.com/wannli/obsidian-reader/commit/81894dd7aa44399c585c465319872cf8491dd666))
* **picker:** add Fileclass destination multiselect and creation ([f921d38](https://github.com/wannli/obsidian-reader/commit/f921d3817505b7ade16b739ac2cbf190606554b5))
* **reader:** add native reference and topic-pill presentation ([d6ebd29](https://github.com/wannli/obsidian-reader/commit/d6ebd291589a304fa3500adeea7bba54776f8d73))
* **reader:** collect highlights across notes with guarded retries ([a66ad57](https://github.com/wannli/obsidian-reader/commit/a66ad575be540de836b67674244ac1bf3627f79f))

## [0.13.1](https://github.com/wannli/obsidian-reader/compare/0.13.0...0.13.1) (2026-10-20)


### Fixed

* **reader:** acknowledge saving an article to Later ([b6b58a9](https://github.com/wannli/obsidian-reader/commit/b6b58a9215427311c3dfafdf447a1e5d317ed168))

## [0.13.0](https://github.com/wannli/obsidian-reader/compare/0.12.0...0.13.0) (2026-10-19)


### Added

* **reader:** add tap highlights and contextual bottom-bar actions ([18f35e0](https://github.com/wannli/obsidian-reader/commit/18f35e058f7db5827e3f7842d33296d8101421ef))

## [0.12.0](https://github.com/wannli/obsidian-reader/compare/0.11.0...0.12.0) (2026-10-19)


### Added

* **reader:** add manual status folder organization command ([3a9d307](https://github.com/wannli/obsidian-reader/commit/3a9d307e91dc5083b49e28523aa6fee42343ee52))
* **reader:** restore folder-authoritative article queues ([990f612](https://github.com/wannli/obsidian-reader/commit/990f6124a0287cd4a84d75d4d45208470c99fd7b))


### Fixed

* **content:** preserve bracketed image alt text ([887f3f5](https://github.com/wannli/obsidian-reader/commit/887f3f5a8793100267d4255df473956983b524c2))
* **reader:** separate paged page and article navigation ([d40f487](https://github.com/wannli/obsidian-reader/commit/d40f487ddeb300ccf114def06c13136a5bd93b0d))

## [0.11.0](https://github.com/wannli/obsidian-reader/compare/0.10.0...0.11.0) (2026-10-16)


### Added

* **reader:** resume dog-eared article from shortcut ([abb3703](https://github.com/wannli/obsidian-reader/commit/abb37037d7c5331ffe2596bfcb2d4e5cded0e4ec))

## [0.10.0](https://github.com/wannli/obsidian-reader/compare/0.9.2...0.10.0) (2026-10-16)


### Added

* **reader:** filter reading lists by topic and create topic notes ([d9f83a4](https://github.com/wannli/obsidian-reader/commit/d9f83a4126b525145b78fb5dab272a578def216a))


### Fixed

* **docs:** make the reader readme more user friendly ([69a6a02](https://github.com/wannli/obsidian-reader/commit/69a6a028161bfe9eddc780b201049e56899f8d76))

## [0.9.2](https://github.com/wannli/obsidian-reader/compare/0.9.1...0.9.2) (2026-10-16)


### Fixed

* **selection:** reconcile stale touch pointers after native release ([f54f604](https://github.com/wannli/obsidian-reader/commit/f54f6040a3081994dbf7016a29b5bc7002ce0f9a))

## [0.9.1](https://github.com/wannli/obsidian-reader/compare/0.9.0...0.9.1) (2026-10-16)


### Fixed

* **selection:** observe gesture releases before propagation stops ([aa88616](https://github.com/wannli/obsidian-reader/commit/aa88616fa9452a502e47b0629a73bd56e44d6b0b))

## [0.9.0](https://github.com/wannli/obsidian-reader/compare/0.8.1...0.9.0) (2026-10-15)


### Added

* **reader:** map yaml statuses to optional folders ([5be9694](https://github.com/wannli/obsidian-reader/commit/5be969459ad99ef7418976c626af25fcf449b9c4))


### Fixed

* **reader:** match image spacing to paragraph rhythm ([b447a91](https://github.com/wannli/obsidian-reader/commit/b447a91f14ed674393a8f0f49a1b85646adcbe35))
* **selection:** defer text extraction until gestures settle ([cab9a00](https://github.com/wannli/obsidian-reader/commit/cab9a0085f78dc8db8faaafd3cf1dc691b697563))

## [0.8.1](https://github.com/wannli/obsidian-reader/compare/0.8.0...0.8.1) (2026-10-15)


### Fixed

* **capture:** extract streamed articles and reject title-only results ([7bcfc5a](https://github.com/wannli/obsidian-reader/commit/7bcfc5a6b185aae719d50823ce5be9ae371d4a63))
* **capture:** integrate new article publication with YAML organization ([532da6d](https://github.com/wannli/obsidian-reader/commit/532da6d9c6ffef078f664665eb24946fc85c75c7))

## [0.8.0](https://github.com/wannli/obsidian-reader/compare/0.7.2...0.8.0) (2026-10-15)


### Added

* **reader:** merge YAML organization with current main ([6e50988](https://github.com/wannli/obsidian-reader/commit/6e50988febf62509acc333d87cc38e9d8c29eb99))
* **reader:** organize articles with YAML status and bookmarks ([977a2ae](https://github.com/wannli/obsidian-reader/commit/977a2ae72379e05576179c9564be68e0bb785ccb))

## [0.7.2](https://github.com/wannli/obsidian-reader/compare/0.7.1...0.7.2) (2026-10-15)


### Fixed

* **release:** build exact tags and retry draft publication ([3b8123e](https://github.com/wannli/obsidian-reader/commit/3b8123ec427c1a81664662d1be01f849d1f1e089))

## [0.7.1](https://github.com/wannli/obsidian-reader/compare/0.7.0...0.7.1) (2026-10-15)


### Fixed

* **capture:** enable native source-link extraction and article redownload ([3c337cd](https://github.com/wannli/obsidian-reader/commit/3c337cd969ede4f0d023be51f37e0c5c3c88b0a0))

## [0.7.0](https://github.com/wannli/obsidian-reader/compare/0.6.2...0.7.0) (2026-10-15)


### Added

* **reader:** clarify later and treasury article actions ([#17](https://github.com/wannli/obsidian-reader/issues/17)) ([e27afff](https://github.com/wannli/obsidian-reader/commit/e27afffcdee977152a3372fde93980cd23d3cfd7))
* **reader:** delegate note actions to shared inline picker ([a45b879](https://github.com/wannli/obsidian-reader/commit/a45b879ad5eaa40436ec160af1b7f4d126c9e05e))
* **reader:** merge shared picker with current toolbar ([183f5eb](https://github.com/wannli/obsidian-reader/commit/183f5eb301e24757306408e30346bc5759e65458))


### Fixed

* **highlights:** map selections through markdown containers ([665ece4](https://github.com/wannli/obsidian-reader/commit/665ece45302159aee23e16d615126fa3eb9098ac))

## [0.6.2](https://github.com/wannli/obsidian-reader/compare/0.6.1...0.6.2) (2026-10-15)


### Fixed

* **reader:** keep saved highlights visible without color ([a062637](https://github.com/wannli/obsidian-reader/commit/a062637a57573508b842f42bbea41729ca4b4733))
* **reader:** recognize confirmed paged scroll limits ([59420a9](https://github.com/wannli/obsidian-reader/commit/59420a93c4bc306b5fbfa3f2bfb580186c786314))
* **reader:** restore fileclass inline discovery ([d807e16](https://github.com/wannli/obsidian-reader/commit/d807e16f40828bb51068af6f652b110aec0cb95e))

## [0.6.1](https://github.com/wannli/obsidian-reader/compare/0.6.0...0.6.1) (2026-10-15)


### Fixed

* **reader:** align reading list and article bottom controls ([7ac6f07](https://github.com/wannli/obsidian-reader/commit/7ac6f07ed3e193a53bbafc43a80b1a838ac6d58b))
* **reader:** allow 900ms to adjust a highlight selection ([021a68e](https://github.com/wannli/obsidian-reader/commit/021a68e87a1d450e2251dd8ade066f21faa9a2d9))
* **reader:** isolate reading gestures from sidebar swipes ([35c3323](https://github.com/wannli/obsidian-reader/commit/35c332322aeafd8e811f909217d8967b592369d7))
* **reader:** page with arrow keys before crossing articles ([9ddfe55](https://github.com/wannli/obsidian-reader/commit/9ddfe5517ece6a9e82b40cecc32302ac0b1ebc27))
* **reader:** remove image viewer frame and close button ([e1a2365](https://github.com/wannli/obsidian-reader/commit/e1a236550d6dfe61a8d2473d27cbf8e8c367f65a))

## [0.6.0](https://github.com/wannli/obsidian-reader/compare/0.5.0...0.6.0) (2026-10-14)


### Added

* **reader:** cap inline images and add tap-to-enlarge ([0574a96](https://github.com/wannli/obsidian-reader/commit/0574a9691e0cc130f38faf90dbb0038d82362a14))
* **reader:** integrate markdown-first rebuild and native reading features ([178622c](https://github.com/wannli/obsidian-reader/commit/178622c6df1589c9b3c5178a1183cd8672e2f2b1))
* **reader:** rebuild markdown-first reading workflow ([cebbb0a](https://github.com/wannli/obsidian-reader/commit/cebbb0a9b172834d8d421d7ad8dae9de531e944d))
* **reader:** rebuild standalone markdown reader ([4268c43](https://github.com/wannli/obsidian-reader/commit/4268c434a22d7c1afa6ab4d8ee012566eccc25ac))
* **reader:** save clicked web links to inbox ([f844c83](https://github.com/wannli/obsidian-reader/commit/f844c83529507c3149f4d764e600b2430f596c7f))
* **reader:** show highlight save feedback and article titles ([f82095e](https://github.com/wannli/obsidian-reader/commit/f82095ef0edf3c809c68066136efab7bbe010dd4))


### Fixed

* **reader:** anchor highlight save feedback inside its pane ([692bafb](https://github.com/wannli/obsidian-reader/commit/692bafb20ffc4500faefae72a20146a2c217cc60))
* **reader:** use local publication dates and explicit feed sync ([268b177](https://github.com/wannli/obsidian-reader/commit/268b1773bf36a4a3b72173699027403e70b218c2))

## [0.5.0](https://github.com/wannli/obsidian-reader/compare/0.4.0...0.5.0) (2026-10-12)


### Added

* **reader:** add safe deletion actions and quieter feed refreshes ([f753123](https://github.com/wannli/obsidian-reader/commit/f753123c15e3178d197f1807358d363282f8ada8))
* **stream:** add standalone cleanup command ([ff11a10](https://github.com/wannli/obsidian-reader/commit/ff11a10d1315868b0f563b84c488879ed5cf5543))


### Fixed

* **reader:** allow stable node links when archiving ([24bd99a](https://github.com/wannli/obsidian-reader/commit/24bd99a49fca3473a717e60158768c47d2871282))

## [0.4.0](https://github.com/wannli/obsidian-reader/compare/0.3.3...0.4.0) (2026-10-12)


### Added

* **reader:** hide mobile chrome while reading ([5e0816b](https://github.com/wannli/obsidian-reader/commit/5e0816bb7f3e314cd18a1278e0c4d04b37f81a29))
* **stream:** expire old items and save annotated articles ([0b2c105](https://github.com/wannli/obsidian-reader/commit/0b2c10574d0974240eb7f713b67cd7d81b6ce1ca))

## [0.3.3](https://github.com/wannli/obsidian-reader/compare/0.3.2...0.3.3) (2026-10-12)


### Fixed

* **images:** prevent background loads and cool down failed requests ([1a57483](https://github.com/wannli/obsidian-reader/commit/1a57483c9e6de646d80d500b9d08d678d6120241))

## [0.3.2](https://github.com/wannli/obsidian-reader/compare/0.3.1...0.3.2) (2026-10-12)


### Fixed

* **reader:** reduce library scan work and restore desktop navigation ([da3c333](https://github.com/wannli/obsidian-reader/commit/da3c3338b0d3a907d52434a076efa174cf9d46b6))

## [0.3.1](https://github.com/wannli/obsidian-reader/compare/0.3.0...0.3.1) (2026-10-12)


### Fixed

* **nodes:** delegate linked node cleanup to nodes ([90d04fe](https://github.com/wannli/obsidian-reader/commit/90d04fe34f193c906ea5c20aef51820eb3aedb71))

## [0.3.0](https://github.com/wannli/obsidian-reader/compare/0.2.1...0.3.0) (2026-10-12)


### Added

* **main:** integrate schema-aware Nodes highlighting ([b6c5c58](https://github.com/wannli/obsidian-reader/commit/b6c5c5883e50aa1841549e6d3a28d17f093b806c))

## [0.2.1](https://github.com/wannli/obsidian-reader/compare/0.2.0...0.2.1) (2026-10-11)


### Improved

* **tooling:** retire native automation and simplify scripts ([3de8e2d](https://github.com/wannli/obsidian-reader/commit/3de8e2d6baab185ac1315486e620f298b81f4f73))

## [0.2.0](https://github.com/wannli/obsidian-reader/compare/0.1.0...0.2.0) (2026-10-11)


### Added

* initialize standalone Reader plugin ([2d48bea](https://github.com/wannli/obsidian-reader/commit/2d48beaad352029496813fd6ba6a6dafddbdeba3))


### Improved

* **reader:** remove retired preview and legacy compatibility ([ebf4dbf](https://github.com/wannli/obsidian-reader/commit/ebf4dbf109dcf3ccd99d3acda0f4e5c0561f7997))

## Changelog

Releases are tracked from the first standalone Reader release onward.
