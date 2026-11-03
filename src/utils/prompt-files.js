'use strict';
// The pipeline skill tells the orchestrating session to hand each target's
// prompt VERBATIM to a subagent. Pasting a 13 KB prompt into an Agent call is
// where that drifted (2026-10-30: subagents were told to "run deep-research.js
// and follow the printed prompt" instead). Writing each prompt to a file and
// handing the subagent a one-line instruction removes the copy step.
const fs = require('fs');
const path = require('path');

const PROMPT_DIR = () => path.join(process.cwd(), 'output', 'tmp_prompts');

function agentInstruction(file) {
  return `Read the file ${file} and follow every instruction in it exactly. Your reply must end with the JSON block that file asks for.`;
}

/** Writes targets[i][promptKey] to output/tmp_prompts/<kind>_<i>.txt and
 *  returns targets with `prompt_file` + `agent_prompt` added. */
function writePromptFiles(kind, targets, promptKey) {
  fs.rmSync(PROMPT_DIR(), { recursive: true, force: true });
  fs.mkdirSync(PROMPT_DIR(), { recursive: true });
  return targets.map((t, i) => {
    const file = path.join(PROMPT_DIR(), `${kind}_${i}.txt`);
    fs.writeFileSync(file, t[promptKey] || '');
    return { ...t, prompt_file: file, agent_prompt: agentInstruction(file) };
  });
}

module.exports = { writePromptFiles, agentInstruction, PROMPT_DIR };
