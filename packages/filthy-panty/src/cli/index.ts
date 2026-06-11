#!/usr/bin/env bun
/**
 * CLI entry point. Convex-like IaC workflow for agents — the command set
 * and sync architecture are specified in docs/plans/beeblast-cli.md.
 * Currently a scaffold: prints the planned surface and resolves nothing.
 */

const VERSION = "0.1.0";

const HELP = `filthy-panty v${VERSION} — agent platform CLI (scaffold)

Usage: filthy-panty <command>

Planned commands (see docs/plans/beeblast-cli.md):
  init        Create a .beeblast/ project shell
  login       Authenticate against the SaaS control plane
  dev         Watch resources, validate, diff, and sync non-destructively
  diff        Show local desired state vs remote state
  deploy      Apply the desired manifest to the deploy environment
  run         Run an agent with a prompt
  env set     Manage encrypted environment variables
  logs        Tail agent logs

Only --help and --version work today.`;

const arg = process.argv[2];

switch (arg) {
  case "--version":
  case "-v":
    console.log(VERSION);
    break;
  case undefined:
  case "--help":
  case "-h":
    console.log(HELP);
    break;
  default:
    console.error(`"${arg}" is not implemented yet.\n`);
    console.log(HELP);
    process.exit(1);
}
