# Domain docs

## Read before exploring

- Read root `GLOSSARY.md` when present.
- Read ADRs in `docs/adr/` relevant to the area being explored.

If these files or directories do not exist, proceed silently.
Do not flag their absence or suggest creating them upfront.
Domain-modeling work creates them lazily as terminology or human
decisions are resolved.

## Layout

This is a single-context repository:

- `GLOSSARY.md`: shared domain vocabulary.
- `docs/adr/0001-descriptive-name.md`: architectural decision records.

This setup does not create a glossary or ADRs.

## Vocabulary

Use glossary terms in issue titles, proposals, hypotheses, and tests.
Avoid synonyms the glossary explicitly rejects.

If a needed concept is absent, reconsider whether it belongs to the
domain; note genuine gaps for domain-modeling work.

## Decision conflicts

Surface contradictions with existing ADRs explicitly rather than
silently overriding them. Explain which decision conflicts and why
reopening it may be warranted.

Record only decisions the human has actually taken.
