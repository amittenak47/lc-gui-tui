import {createRoot} from "react-dom/client";
import {App} from "../src/App";
import {LcClient} from "../src/api/client";
import "../src/styles.css";
const calls:string[]=[];
const detail={dataset:"leetcode",key:"leetcode/1-two-sum",task_id:"1-two-sum",question_id:"1",difficulty:"Easy",tags:[],problem_description:"Find the two numbers that add to the target.",starter_code:"class Solution:\n    def twoSum(self, nums, target):\n        pass",entry_point:"twoSum",cases:[]};
const responses:Record<string,unknown>={getConfig:{default_provider:"openai"},capabilities:{modes:[]},getSession:{started_at:1,queue:[],problems:{},reveals:{}},health:{ok:true},getProblem:detail,
 loadProblem:{dataset:"leetcode",task_id:detail.task_id,resume:{attempt:{solved:false,saved:true,archives:[],updated_at:1},board:null,agent_messages:[]}},getSolution:{source:detail.starter_code},getProblemPad:null,scaffoldBoard:{},tags:[],datasets:[],adjacentProblems:{prev:null,next:null},listDevices:[],listProblemPads:[],listWhiteboards:[],listAnnotate:[],getDevice:null};
for(const key of Object.getOwnPropertyNames(LcClient.prototype))if(key!=="constructor" && typeof (LcClient.prototype as any)[key]==="function"){
 (LcClient.prototype as any)[key]=async()=>{calls.push(key);if(key in responses)return responses[key];throw new Error(`Fixture has no response: ${key}`);};
}
localStorage.setItem("whiteboard.tabs.v1",JSON.stringify({v:1,tabs:[{id:"practice",kind:"practice",title:"Two Sum",dataset:"leetcode",taskId:detail.task_id,dirty:false,index:"idle",touched:1}],activeId:"practice",groups:[]}));
Object.assign(window,{fixtureCalls:calls,reviewReady:true});
createRoot(document.querySelector("#root")!).render(<App/>);
