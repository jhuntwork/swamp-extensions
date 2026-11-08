# `@jeremy/mere-stagecraft`

This extension implements the Stagecraft tracker contract for GitHub Issues.
It provides idempotent issue fetch, create, comment, status, type, relation,
and read-only preflight operations through the `@webframp/github` behavior type.

The adapter uses the authenticated `gh` executable for GitHub operations. It
bounds each subprocess to 2 MiB of output and 30 seconds, and terminates timed
out or aborted commands. It keeps relation state in Swamp data and never treats GitHub labels as the source
of Stagecraft state. The Stagecraft factory and repository-specific bindings
live in the Mere operations repository.

This package is the source-controlled successor to the local phase-2 spike.
Tracker conformance and persistent-serve lifecycle checks are required before
it is treated as production-ready.
