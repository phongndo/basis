Before architectural work:
- read docs/architecture.md
- read docs/quality.md

Project rules:
- architecture docs define constraints, not implementation steps
- inspect before editing
- make one cohesive change at a time
- prefer deleting duplicated responsibility
- do not introduce speculative abstractions
- identify ownership for every new mutable value
- identify whether work is on a multiplicative hot path
- characterize behavior before broad refactors
- measure performance-sensitive changes
- after implementation, review whether the system became simpler
