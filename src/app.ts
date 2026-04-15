import express, { Request, Response } from "express";
import { readFileSync } from "fs";
import bodyParser from "body-parser";
import twilio from "twilio";
import axios from "axios";
import { CallInstance } from "twilio/lib/rest/api/v2010/account/call.js";
import { config } from "dotenv";
import { EventEmitter } from "events";

config();

const { twiml } = twilio;

function getEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Environment variable ${name} is missing!`);
  }
  return value;
}

const app: express.Express = express();

// Twilio sends data as URL-encoded forms
app.use(bodyParser.urlencoded({ extended: false }));

const SLACK_WEBHOOK_URL = getEnv("SLACK_WEBHOOK_URL");
const PORT = Number(getEnv("PORT")) || 3000;
const TWILIO_SID = getEnv("TWILIO_SID");
const TWILIO_TOKEN = getEnv("TWILIO_TOKEN");
const HOLD_MUSIC = getEnv("HOLD_MUSIC");
const ROOT_URL = getEnv("ROOT_URL");
const AGENTS: Record<string, string> = JSON.parse(
  readFileSync("agents.json", { encoding: "utf-8" }),
);

enum Action {
  FINISHED = "finished",
  WHISPER = "whisper",
  ANSWERED = "answered",
}

type ActionParams = {
  [Action.FINISHED]: {};
  [Action.WHISPER]: {
    agentNumber: string;
  };
  [Action.ANSWERED]: {
    agentNumber: string;
  };
};

class Agent {
  call: Promise<CallInstance> | null;
  number: string;
  name: string;
  constructor(number: string, name: string) {
    this.call = null;
    this.number = number;
    this.name = name;
  }

  toString() {
    return `(${this.name}: ${this.number} [${this.call ? "In call" : "Free"}])`;
  }

  async clean() {
    const call = await this.call;
    console.log("DEBUG:", "Cleaning agent", this.toString());
    if (call) {
      await twilioClient.calls(call.sid).update({ status: "completed" });
      this.call = null;
      // 2s wait for lines to clear
      await new Promise((r) => setTimeout(r, 2000));
      AgentPool.emit("freed", this);
    }
  }

  statusUrl(conference: Conference) {
    const url = new URL(ROOT_URL + "/agentStatus");
    url.searchParams.append("conferenceName", conference.id);
    url.searchParams.append("agentNumber", this.number);

    return url.toString();
  }

  async startCall(conference: Conference) {
    this.call = twilioClient.calls.create({
      to: this.number,
      from: conference.callerNumber,
      url: conference.actionUrl(Action.WHISPER, {
        agentNumber: this.number,
      }),
      statusCallback: this.statusUrl(conference),
    });
  }
}

class AgentPoolManager extends EventEmitter<{
  cleanup: [Conference];
  accepted: [Conference, Agent];
  freed: [Agent];
}> {
  agents: Record<string, Agent>;
  queue: Conference[];
  constructor() {
    super();
    this.agents = {};
    this.queue = [];
    for (const k in AGENTS) {
      this.agents[k] = new Agent(k, AGENTS[k]);
    }

    this.on("accepted", (conf, agent) => {
      console.log("DEBUG:", "Conf", conf.id, "accepted by", agent.name);
      this.queue = this.queue.filter((c) => c.id !== conf.id);
      const freedAgents = conf.attachedAgents.filter(
        (a) => a.number !== agent.number,
      );
      conf.attachedAgents = conf.attachedAgents.filter(
        (a) => a.number === agent.number,
      );
      for (const freedAgent of freedAgents) {
        freedAgent.clean();
      }
    });

    this.on("cleanup", (conf) => {
      console.log("DEBUG:", "Running cleanup on", conf.id);
      for (const agent of conf.attachedAgents) {
        agent.clean();
      }
      this.queue = this.queue.filter((c) => c.id !== conf.id);
    });

    this.on("freed", this.callAvailable);
  }

  public get freeAgents() {
    return Object.entries(this.agents)
      .filter(([, info]) => !info.call)
      .map(([, info]) => info);
  }

  submitConference(conference: Conference) {
    this.queue.push(conference);
    this.callAvailable();
  }

  callAvailable() {
    console.log("Calling available agents: ", this.freeAgents, this.queue);
    if (this.queue.length === 0) {
      // nothin' to do
      return;
    }
    const current = this.queue[0];

    const free = this.freeAgents;
    for (const freeAgent of free) {
      freeAgent.startCall(current);
      current.attachedAgents.push(freeAgent);
    }
  }

  getByNumber(agentNumber: string) {
    if (!this.agents?.[agentNumber]) {
      throw new Error("Could not get agent number: " + agentNumber);
    }
    return this.agents[agentNumber];
  }
}

const AgentPool = new AgentPoolManager();

class Conference {
  // Internal ID
  id: string;
  baseUrl: string;
  attachedAgents: Agent[];
  // Is an agent connected to the client?
  live: boolean;
  callerNumber: string;

  constructor(baseUrl: string, conferenceName: string, callerNumber: string) {
    this.id = conferenceName;
    this.baseUrl = baseUrl;
    this.attachedAgents = [];
    this.live = false;
    this.callerNumber = callerNumber;
    console.log(`DEBUG: New conference = ${this.id}`);
    // Register self in global state
    activeConferences.set(this.id, this);
  }

  cleanup() {
    activeConferences.delete(this.id);
    AgentPool.emit("cleanup", this);
  }

  actionUrl<T extends Action>(action: T, data: ActionParams[T]) {
    const url = new URL(`${this.baseUrl}/call`);
    url.searchParams.append("conferenceName", this.id);
    url.searchParams.append("action", action);
    for (const [k, v] of Object.entries(data)) {
      url.searchParams.append(k, v);
    }
    return url.toString();
  }

  initialize(event: any) {
    const response = new twiml.VoiceResponse();

    console.log("DEBUG: Initial Caller / Dial Logic");
    axios.post(SLACK_WEBHOOK_URL, {
      text: `☎️ Incoming call to number from: ${event.From}`,
    });

    console.log("DEBUG: Put the incoming caller into a unique Conference room");
    const dial = response.dial({
      action: this.actionUrl(Action.FINISHED, {}),
    });

    dial.conference(
      {
        startConferenceOnEnter: true,
        endConferenceOnExit: true,
        waitUrl: HOLD_MUSIC, // ring sound for incoming caller,
        waitMethod: "GET",
      },
      this.id,
    );

    console.log("DEBUG: Triggering independent API calls for each agent");
    AgentPool.submitConference(this);
    return response;
  }

  async finished() {
    const response = new twiml.VoiceResponse();

    if (this.live) {
      await axios.post(SLACK_WEBHOOK_URL, {
        text: `✅ Finished call from ${this.callerNumber}`,
      });
    } else {
      await axios.post(SLACK_WEBHOOK_URL, {
        text: `❌ Missed call from ${this.callerNumber}`,
      });
    }
    this.cleanup();
    response.hangup();
    return response;
  }

  async agentWhisper(event: any, query: ActionParams["whisper"]) {
    const response = new twiml.VoiceResponse();
    if (this.live) {
      console.log("DEBUG", "Call answered by coworker.", this.attachedAgents);
      response.say("Call answered by coworker");
      response.hangup();
      return response;
    }

    const gather: InstanceType<typeof twiml.VoiceResponse.Gather> =
      response.gather({
        numDigits: 1,
        action: this.actionUrl(Action.ANSWERED, { agentNumber: event.To }),
        // short timeout so the "incoming agent call" loops
        timeout: 2,
      });
    gather.say("Incoming agent call. Press 1 to connect.");
    response.redirect(
      this.actionUrl(Action.WHISPER, {
        agentNumber: query.agentNumber,
      }),
    );

    return response;
  }

  async agentAction(
    event: any,
    query: {
      agentNumber: string;
    },
  ) {
    const response = new twiml.VoiceResponse();
    const agent = AgentPool.getByNumber(event.To);

    if (this.live) {
      response.say("Call answered by coworker.");
      response.hangup();
    } else if (event.Digits === "1") {
      console.log("DEBUG: Call connected to", agent.toString());

      console.log("DEBUG: Checking if the caller is still there");
      const conferences = await twilioClient.conferences.list({
        friendlyName: this.id,
        status: "in-progress", // Only look for active ones
        limit: 1,
      });
      // If no active conference is found, the caller has already left :-()
      if (conferences.length === 0) {
        console.log("DEBUG: caller hung up before agent could join");
        response.say("I'm sorry: the caller has already hung up. Good bye!");
        response.hangup();
        this.cleanup();
        return response;
      }

      if (!query.agentNumber) {
        throw new Error("CRITICAL: agentNumber missing");
      }

      await axios.post(SLACK_WEBHOOK_URL, {
        text: `✅ Call answered by agent: ${agent}`,
      });

      this.live = true;

      console.log("DEBUG: Join THIS agent to the conference");
      console.log(`DEBUG: conferenceName = ${this.id}`);
      response.dial().conference(
        {
          startConferenceOnEnter: true,
          endConferenceOnExit: false, // Agent leaving doesn't kill the call
        },
        this.id,
      );

      // Kill all OTHER agent calls so their phones stop ringing
      // We look for calls to our agent numbers that are still 'queued' or 'ringing'
      console.log("DEBUG: killing other agent calls");
      AgentPool.emit("accepted", this, agent);
    } else {
      console.log("DEBUG: Agent pressed not-1");
      // Redirect back to the whisper logic to repeat the prompt
      response.redirect(
        this.actionUrl(Action.WHISPER, {
          agentNumber: query.agentNumber,
        }),
      );
    }
    return response;
  }
}

// Local db of which calls were answered by any agent
const activeConferences = new Map<string, Conference>();

// Create Twilio client for Twilio Conferences
const twilioClient = twilio(TWILIO_SID, TWILIO_TOKEN);

app.post("/agentStatus", async (req: Request, res: Response) => {
  const event: any = req.body;
  const { conferenceName, agentNumber } = req.query;
  const conference = activeConferences.get(conferenceName as string);
  if (conference?.live && event?.CallStatus === "completed") {
    // if this agent is the one on the call
    if (
      conference.attachedAgents.filter((x) => x.number === agentNumber)
        .length === 1
    ) {
      await twilioClient.calls.get(conference.id).update({
        status: "completed",
      });
    }
  }

  return res.send("");
});

// Endpoint for Twilio calls
app.post("/call", async (req: Request, res: Response) => {
  const event: any = req.body;
  const rawAction = req.query["action"];
  const action = typeof rawAction === "string" ? rawAction : "";

  const conferenceName = req.query?.conferenceName as string;
  const conference = activeConferences.get(conferenceName);

  console.log(`DEBUG: action = ${action}`);
  console.log(`DEBUG: event = ${JSON.stringify(event, null, 2)}`);

  try {
    if (action === "whisper") {
      console.log("DEBUG: Whisper Logic: agent answers");
      if (!conference) {
        throw new Error("CRITICAL: conferenceName missing");
      }

      const response = await conference.agentWhisper(event, req.query as any);
      res.type("text/xml").send(response.toString());
      return;
    }

    // Agent button pressing logic
    if (action === "answered") {
      console.log("DEBUG: Agent button pressing logic");
      if (!conference) {
        throw new Error("CRITICAL: conferenceName missing");
      }
      const response = await conference.agentAction(event, req.query as any);
      res.type("text/xml").send(response.toString());
      return;
    }

    // Finished call logic
    if (action === "finished") {
      console.log(`DEBUG: Finished call path`);
      if (!conference) {
        throw new Error("CRITICAL: conferenceName missing");
      }
      const response = await conference.finished();

      res.type("text/xml").send(response.toString());
      return;
    }

    // Fresh call (no DialStatus yet)
    if (!event.DialStatus) {
      // Start a call
      const conference = new Conference(ROOT_URL, event.CallSid, event.To);
      const resp = conference.initialize(event);

      // IMMEDIATELY send TwiML back so the caller enters the room
      res.type("text/xml").send(resp.toString());
      return;
    }

    const response = new twiml.VoiceResponse();

    console.error(`DEBUG: unknown state action = ${action}`);
    res.type("text/xml").send(response.toString());
  } catch (error: unknown) {
    console.error(error);
    res.status(500).send("Error processing TwiML");
  }
});

process.on("unhandledRejection", console.warn);

app.listen(PORT, (): void => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
  console.log(`Point your Twilio call webhook to /call`);
});
