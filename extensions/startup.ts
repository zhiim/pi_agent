export default async function () {
  // set PI_CODING_AGENT_DIR to set web-access config file path
  process.env.PI_CODING_AGENT_DIR = `${process.env.HOME}/.pi/agent/`;
}
