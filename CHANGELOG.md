# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

A `vX.Y.Z` tag runs `publish-npm.yml` (publishing `packages/fiat24` via npm
trusted publishing / OIDC) and `release.yml` (the GitHub Release).

## [Unreleased]

### Added

- Repository scaffold: `@qntx/fiat24` (`packages/fiat24`) with the layered
  structure (`abi`, `core`, `deployments`, `calls`, `events`, `chain`,
  `api`, `flows`), one subpath export per layer, and the `Fiat24Error`
  error type. No Fiat24 logic yet.
