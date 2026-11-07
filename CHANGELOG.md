## [2.0.3](https://github.com/CoCreateJS/usage/compare/v2.0.2...v2.0.3) (2026-11-07)


### Bug Fixes

* bump CoCreate dependency versions ([0048da5](https://github.com/CoCreateJS/usage/commit/0048da5b2c0cba6752a1c5d65f49dc61e6311abe))
* consolidate CRUD client and server packages ([27f5a7f](https://github.com/CoCreateJS/usage/commit/27f5a7f6cfe31bbf9ace546327a69053fbca422e))

## [2.0.2](https://github.com/CoCreateJS/usage/compare/v2.0.1...v2.0.2) (2026-11-07)


### Bug Fixes

* flush organization usage on disconnect ([dd36be1](https://github.com/CoCreateJS/usage/commit/dd36be1d53f0fc483728eaac7fd7fad24cd41098))
* normalize usage pricing calculations ([a84f144](https://github.com/CoCreateJS/usage/commit/a84f14418185011ba0d6399adfd7fba88b898450))

## [2.0.1](https://github.com/CoCreateJS/usage/compare/v2.0.0...v2.0.1) (2026-11-05)


### Bug Fixes

* upgrade CoCreate dependencies to v2 ([78b5407](https://github.com/CoCreateJS/usage/commit/78b5407dfadc5928ee982092822999458ce1d71e))

# [2.0.0](https://github.com/CoCreateJS/usage/compare/v1.4.1...v2.0.0) (2026-11-02)


* refactor!: rename usage package to server-usage ([b8bfd0e](https://github.com/CoCreateJS/usage/commit/b8bfd0e5f5edcaf291b7f7b68bd891b2095fa03a))


### Bug Fixes

* add Deno specific entries to .gitignore ([064357b](https://github.com/CoCreateJS/usage/commit/064357beb36c50fce2833fc193c9f18f6250a0eb))
* bump [@cocreate](https://github.com/cocreate) dependencies ([df6cead](https://github.com/CoCreateJS/usage/commit/df6cead1f320ae6392bee045cac55543d63d0e72))
* bump versions ([28302b5](https://github.com/CoCreateJS/usage/commit/28302b53e8e9143dc0e62f347f89f6a84c0d7d44))
* bumped dependencies ([a222434](https://github.com/CoCreateJS/usage/commit/a2224341edf84a0008880cabba4e5530ef2992d4))
* missing dependencies ([f6f9b64](https://github.com/CoCreateJS/usage/commit/f6f9b648b3d7181a632eb32194dca37748426544))
* remove trailing slash from node_modules entry in .gitignore ([a9129ad](https://github.com/CoCreateJS/usage/commit/a9129ad7fbe2854720628fc3f3e2fc4741ff0266))
* restore usage payload byte calculation ([44ada2d](https://github.com/CoCreateJS/usage/commit/44ada2d0ed413834553f100055344ef52e09b794))
* update buffer and database references from 'system' to 'server' ([817f918](https://github.com/CoCreateJS/usage/commit/817f918e04a000e723f9ebae73f803432464a362))
* update copyright year and refactor usage tracking implementation ([d652fee](https://github.com/CoCreateJS/usage/commit/d652fee3ca6bbf2f3bac8c72c7910c7bc2e2de7b))
* update git url ([6af6fe9](https://github.com/CoCreateJS/usage/commit/6af6fe923eb99d4379ae4b3a67a88acf70057af1))
* update GitHub Actions to use latest versions and sync package.json description ([8fe2d1b](https://github.com/CoCreateJS/usage/commit/8fe2d1bcfbd38040b866cdedd5e1dc0f8438cf22))


### Features

* add @cocreate/crud-server dependency to package.json ([070bf5d](https://github.com/CoCreateJS/usage/commit/070bf5d0268e28f2e458477ffd82de3262126448))
* bump all dependencies ([82da984](https://github.com/CoCreateJS/usage/commit/82da9845a4f27e98f09cc147fb87bf77d17597b3))
* bumped all dependency versions ([8700f45](https://github.com/CoCreateJS/usage/commit/8700f4526041dfb49a2a07900c1fe5f026979769))


### BREAKING CHANGES

* package name changes from @cocreate/usage to @cocreate/server-usage; consumers must update their dependency name.

## [1.4.1](https://github.com/CoCreateJS/usage/compare/v1.4.0...v1.4.1) (2026-07-19)


### Bug Fixes

* set default branch to main ([81f49a3](https://github.com/CoCreateJS/usage/commit/81f49a3c73fd5c09e49779430bfa44c49392482a))

# [1.4.0](https://github.com/CoCreateJS/usage/compare/v1.3.0...v1.4.0) (2026-07-18)


### Features

* enhance event listener handling and improve logging for organization deletion ([cca2e40](https://github.com/CoCreateJS/usage/commit/cca2e408ba2c6599aab2b56430b1d74b923fbb57))
* refactor usage tracking with new bandwidth management and event listeners ([76f8ddb](https://github.com/CoCreateJS/usage/commit/76f8ddb539ad6a3384ed5d1557b1e36b9d64222a))

# [1.3.0](https://github.com/CoCreateJS/usage/compare/v1.2.2...v1.3.0) (2026-07-17)


### Features

* update automated workflow and release configuration for improved semantic release handling ([47aa8c2](https://github.com/CoCreateJS/usage/commit/47aa8c2941f8393a0ca55cbf6f66ae4df1172dea))

## [1.2.2](https://github.com/CoCreateJS/usage/compare/v1.2.1...v1.2.2) (2026-07-14)


### Bug Fixes

* remove unnecessary console logs in init function for cleaner output ([af5f039](https://github.com/CoCreateJS/usage/commit/af5f03958fa5e84008411e99186bcdea438e7087))
* removed post install ([933f2b6](https://github.com/CoCreateJS/usage/commit/933f2b6b9a7a551afb7e2723bfd02de9a72f2019))
* semantic version handling. Reorganize .gitignore for improved clarity and structure ([9d67031](https://github.com/CoCreateJS/usage/commit/9d67031f6144a5b767ff0a2b6d487b14cbbd33aa))
* update module export to ES6 syntax in release.config.js ([8908cb7](https://github.com/CoCreateJS/usage/commit/8908cb7ea61ceb65d1151909e8706c0a54046903))
* update organization ID reference and host variable in sendUsageUpdate function ([4f4cc11](https://github.com/CoCreateJS/usage/commit/4f4cc11f9d0757b27c71f180ce83895fb2c436cd))
* update package.json to use ESM and restructure entry points ([c96c5db](https://github.com/CoCreateJS/usage/commit/c96c5db22a621d2af2a151d2173ffaa265c03f6e))

## [1.2.1](https://github.com/CoCreateJS/usage/compare/v1.2.0...v1.2.1) (2025-05-01)


### Bug Fixes

* update [@cocreate](https://github.com/cocreate) dependencies ([945ecb8](https://github.com/CoCreateJS/usage/commit/945ecb85f25dd67a7390f6c68c07721e21e401d5))
* updated render selector to render-query ([33a8814](https://github.com/CoCreateJS/usage/commit/33a8814e3b724ef87541410df800825bf22fb178))

# [1.2.0](https://github.com/CoCreateJS/usage/compare/v1.1.3...v1.2.0) (2024-11-04)


### Bug Fixes

* prettier.config options ([6397cac](https://github.com/CoCreateJS/usage/commit/6397cacf8dccf8dd2032ec694fd5edf0f6b0761f))


### Features

* add prettier.config.js and format files ([1b89a27](https://github.com/CoCreateJS/usage/commit/1b89a27e33151958481813410d916aa4ff3c346f))

## [1.1.3](https://github.com/CoCreateJS/usage/compare/v1.1.2...v1.1.3) (2024-06-23)


### Bug Fixes

* bump dependencies ([9e1a377](https://github.com/CoCreateJS/usage/commit/9e1a377c85c34b7d93124fa1da7acd26cc2e2206))

## [1.1.2](https://github.com/CoCreateJS/usage/compare/v1.1.1...v1.1.2) (2024-06-23)


### Bug Fixes

* update dependencies ([6666e9a](https://github.com/CoCreateJS/usage/commit/6666e9aba04e1c50904bfabbdfbd708267f16766))

## [1.1.1](https://github.com/CoCreateJS/usage/compare/v1.1.0...v1.1.1) (2024-02-05)


### Bug Fixes

* Removed https://cdn.CoCreateJS.com/latest/CoCreate.min.css ([5184808](https://github.com/CoCreateJS/usage/commit/518480890edeb1f63a3b5a6858d875ee42f7ceda))

# [1.1.0](https://github.com/CoCreateJS/usage/compare/v1.0.0...v1.1.0) (2024-01-08)


### Bug Fixes

* applied host to define environment/branch ([8d7404c](https://github.com/CoCreateJS/usage/commit/8d7404ca75eeece4a17a9477d25101ccdab0a8ed))


### Features

* bumped CoCreate dependencies to their latest versions ([6e0b814](https://github.com/CoCreateJS/usage/commit/6e0b814e6afda547fceca6b7248ea5181de7843b))

# 1.0.0 (2023-11-29)


### Features

* Initial Release ([b0d9d8d](https://github.com/CoCreateJS/usage/commit/b0d9d8dc04827ffcead88f720afd0d69fd8a80ad))
