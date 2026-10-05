/** @vitest-environment jsdom */
import {act,useState} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {SettingsChoices} from './SettingsChoices';

let host:HTMLDivElement;let root:Root;
beforeEach(()=>{vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);host=document.createElement('div');document.body.append(host);root=createRoot(host);});
afterEach(()=>{act(()=>root.unmount());host.remove();vi.unstubAllGlobals();});

function Choice({options,compact=false}:{options:Array<[string,string?]>;compact?:boolean}){
  const [answer,setAnswer]=useState(options[0]![0]);
  return <SettingsChoices className={compact?'lc-settings-choice lc-settings-choice-compact':'lc-settings-choice'} role="radiogroup" aria-label="Question">
    {options.map(([name,blurb])=><button key={name} type="button" role="radio" aria-checked={answer===name} onClick={()=>setAnswer(name)}>
      <strong>{name}</strong>{blurb && <span className="lc-muted">{blurb}</span>}
    </button>)}
  </SettingsChoices>;
}
const group=()=>host.querySelector('[role=radiogroup]')!;

it('allows keyboard selection when a setting has no initial answer',()=>{
  function Question(){
    const [answer,setAnswer]=useState<boolean|null>(null);
    return <SettingsChoices role="radiogroup" aria-label="Accepts images">
      <button role="radio" aria-checked={answer===false} onClick={()=>setAnswer(false)}><strong>No</strong></button>
      <button role="radio" aria-checked={answer===true} onClick={()=>setAnswer(true)}><strong>Yes</strong></button>
    </SettingsChoices>;
  }
  act(()=>root.render(<Question/>));
  const [no,yes]=[...host.querySelectorAll('button')];
  expect(no.tabIndex).toBe(0);expect(yes.tabIndex).toBe(-1);
  act(()=>{no.focus();no.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));});
  expect(document.activeElement).toBe(yes);expect(yes.getAttribute('aria-checked')).toBe('true');
  expect(yes.tabIndex).toBe(0);expect(no.tabIndex).toBe(-1);
});

it('joins two short answers into one segmented control',()=>{
  act(()=>root.render(<Choice options={[['Right hand'],['Left hand']]}/>));
  expect(group().classList).toContain('is-segmented');
});

it('makes Off / 3s / 5s segmented even when the group asked for compact',()=>{
  act(()=>root.render(<Choice compact options={[['Off'],['3s'],['5s']]}/>));
  expect(group().classList).toContain('is-segmented');
  expect(group().classList).not.toContain('is-pills');
});

it('keeps a radio list when the answers carry descriptions',()=>{
  act(()=>root.render(<Choice options={[['Place on board','No file is written.'],['Place and save','Also saves a PNG.'],['Save only','The board is left as it was.']]}/>));
  expect(group().classList).toContain('is-radio-list');
  expect(host.querySelectorAll('.lc-muted')).toHaveLength(3);
});

it('keeps pills and lists past four answers',()=>{
  act(()=>root.render(<Choice compact options={[['1'],['2'],['3'],['4'],['5']]}/>));
  expect(group().classList).toContain('is-pills');
  act(()=>root.render(<Choice options={[['a'],['b'],['c'],['d'],['e']]}/>));
  expect(group().classList).toContain('is-radio-list');
});

it('still moves the selection with arrow keys once segmented',()=>{
  act(()=>root.render(<Choice compact options={[['Off'],['3s'],['5s']]}/>));
  const [off,three,five]=[...host.querySelectorAll<HTMLButtonElement>('button')];
  act(()=>{off!.focus();off!.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));});
  expect(document.activeElement).toBe(three);expect(three!.getAttribute('aria-checked')).toBe('true');
  act(()=>{three!.dispatchEvent(new KeyboardEvent('keydown',{key:'End',bubbles:true}));});
  expect(five!.getAttribute('aria-checked')).toBe('true');
  act(()=>{five!.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));});
  expect(off!.getAttribute('aria-checked')).toBe('true');
});
