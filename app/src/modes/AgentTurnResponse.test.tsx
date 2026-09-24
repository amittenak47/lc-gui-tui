/** @vitest-environment jsdom */
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AgentTurnResponse } from "./AgentTurnResponse";
import { DEFAULT_AGENT_DISPLAY_PREFS } from "../util/agentDisplayPrefs";

// Control the actual disclosure-completion boundary, not a guessed timeout.
vi.mock("../components/AnimatedDisclosure", () => ({ AnimatedDisclosure: ({open,children,onExitComplete}: {
  open: boolean; children: ReactNode; onExitComplete?: () => void;
}) => <div data-open={open}>{open ? children : <button data-collapse-end onClick={onExitComplete}>Finish fold</button>}</div> }));
let host: HTMLDivElement; let root: Root;
const events = [{kind:"stage" as const,label:"reason",detail:"Read every word of this full step.",ts:1}];
beforeEach(()=>{
  vi.useFakeTimers();vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT",true);
  host=document.createElement("div");document.body.append(host);root=createRoot(host);
});
afterEach(()=>{act(()=>root.unmount());host.remove();vi.useRealTimers();vi.unstubAllGlobals();});
const render=(pending:boolean,text="",withSteps=true,autoCollapseThinking=true,showProcess=true)=>act(()=>root.render(<AgentTurnResponse
  pending={pending} text={text} assistant events={withSteps?events:[]} reasoning="Provider reasoning."
  showProcess={showProcess} displayPrefs={{...DEFAULT_AGENT_DISPLAY_PREFS,autoCollapseThinking}} />));

it("keeps full Thinking open by default as the answer arrives",()=>{
  render(true,"",true,false); render(false,"Answer",true,false);
  expect(host.querySelector('.lc-agent-process-toggle')?.getAttribute('aria-expanded')).toBe('true');
  expect(host.querySelector('.lc-agent-process-step-toggle')?.getAttribute('aria-expanded')).toBe('true');
  expect(host.querySelector('.lc-agent-turn-body')).not.toBeNull();
});
it("never waits for a hidden progress section to fold",()=>{
  render(true,"",true,true,false); render(false,"Answer",true,true,false);
  expect(host.querySelector('.lc-agent-process')).toBeNull();
  expect(host.querySelector('.lc-agent-turn-body')).not.toBeNull();
});

it("places full live steps above dots, folds, then reveals the answer",()=>{
  render(true);
  const steps=host.querySelector('.lc-agent-think-stack')!;
  const dots=host.querySelector('[aria-hidden="true"][style]')!;
  expect(steps.compareDocumentPosition(dots)&Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(host.querySelector('.lc-agent-reasoning')).toBeNull();
  act(()=>vi.advanceTimersByTime(1000));
  expect(steps.textContent).toContain('Read every word of this full step.');
  render(false,'Answer one two.');
  expect(host.querySelector('.lc-agent-turn-body')).toBeNull();
  expect(host.querySelector('.lc-agent-reasoning')).toBeNull();
  act(()=>host.querySelector<HTMLButtonElement>('[data-collapse-end]')!.click());
  expect(host.querySelector('.lc-agent-reasoning-toggle')?.getAttribute('aria-expanded')).toBe('false');
  expect(host.querySelector('.lc-agent-process-toggle')?.getAttribute('aria-expanded')).toBe('false');
  // Reveal animates opacity on complete text so the answer never reflows.
  expect(host.querySelector('.lc-agent-turn-body')?.textContent?.trim()).toBe('Answer one two.');
  expect(host.querySelectorAll('.lc-agent-word-reveal')).toHaveLength(3);
  act(()=>vi.advanceTimersByTime(200));
  expect(host.querySelector('.lc-agent-turn-body')?.textContent?.trim()).toBe('Answer one two.');
});
it("does not animate restored history or wait when there were no steps",()=>{
  render(false,'Saved complete answer.');
  expect(host.querySelector('.lc-agent-turn-body')?.textContent).toContain('Saved complete answer.');
  render(true,'',false);render(false,'Cancelled',false);
  act(()=>vi.advanceTimersByTime(100));
  expect(host.querySelector('.lc-agent-turn-body')?.textContent).toContain('Cancelled');
});
it("skips the fold/reveal wait with reduced motion and cleans up timers",()=>{
  vi.stubGlobal('matchMedia',()=>({matches:true}));
  render(true);render(false,'Finished immediately.');
  expect(host.querySelector('.lc-agent-turn-body')?.textContent).toContain('Finished immediately.');
  act(()=>root.render(null));expect(vi.getTimerCount()).toBe(0);
});
it("does not strand the answer if the app backgrounds during the fold",()=>{
  render(true);render(false,'Background answer.');
  const spy=vi.spyOn(document,'hidden','get').mockReturnValue(true);
  act(()=>document.dispatchEvent(new Event('visibilitychange')));
  expect(host.querySelector('.lc-agent-turn-body')?.textContent).toContain('Background answer.');
  spy.mockRestore();
});
