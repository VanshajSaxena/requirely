import type { OutputTarget } from '../domain/index.ts';
import { renderAgentPrompt } from './agent-prompt.ts';
import { renderRequirementsDoc } from './requirements-doc.ts';
import { renderSrs } from './srs.ts';
import type { Projection, ProjectionInput } from './types.ts';

export { renderAgentPrompt } from './agent-prompt.ts';
export { renderRequirementsDoc } from './requirements-doc.ts';
export { renderSrs } from './srs.ts';
export type { Projection, ProjectionInput } from './types.ts';

/**
 * Every projection, keyed by the target the session may have declared.
 *
 * A `Record<OutputTarget, …>` rather than a `switch`: adding a target to the
 * domain enum then fails to compile here until a renderer exists, which is the
 * difference between "the compiler told me" and "it returned undefined at
 * runtime".
 */
const PROJECTIONS: Record<OutputTarget, Projection> = {
  srs: renderSrs,
  'requirements-doc': renderRequirementsDoc,
  'agent-prompt': renderAgentPrompt,
};

/**
 * Renders a stored revision as the requested document.
 *
 * Pure: same input, same bytes, no model call, no I/O, no tokens. That is
 * invariant #1 — *understanding is the durable artifact, output formats are
 * projections over it* — made executable. If a projection ever needs to invent
 * content, the `Understanding` was missing something and the fix belongs
 * upstream in the engine, not in a renderer papering over it.
 *
 * The target is a parameter rather than read from `session.outputTarget`,
 * because that field is the user's *stated intent* and is nullable by design —
 * the spec allows deciding what you want after dumping the context. The caller
 * chooses at render time.
 */
export function project(target: OutputTarget, input: ProjectionInput): string {
  return PROJECTIONS[target](input);
}
