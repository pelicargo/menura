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
const AGENTS: Record<string, string> = JSON.parse(
  readFileSync("agents.json", { encoding: "utf-8" }),
);

// Actions handled by the system. No action usually indicates a new call
enum Action {
  // Whisper is the event where the agent can press 1 to accept
  WHISPER = "whisper",
  ANSWERED = "answered",
  // Triggered when a call ends
  FINISHED = "finished",
  CONFERENCE_STATUS = "conferenceStatus",
  RECORDING = "recording",
}

type ActionParams = {
  [Action.FINISHED]: {};
  [Action.WHISPER]: {
    agentNumber: string;
  };
  [Action.ANSWERED]: {
    agentNumber: string;
  };
  [Action.CONFERENCE_STATUS]: {};
  [Action.RECORDING]: {};
};

// Represents someone who answers calls
class Agent {
  // We don't need the call info immediately, so we can store it as a promise for when it is needed to avoid unnecessary await
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
      // End the call forcefully
      await twilioClient.calls(call.sid).update({ status: "completed" });
      this.call = null;
      // 2s wait for line to clear
      await new Promise((r) => setTimeout(r, 2000));
      AgentPool.emit("freed", this);
    }
  }

  // Similar to actionUrl on `Conference`
  statusUrl(conference: Conference) {
    const url = new URL(conference.baseUrl + "/agentStatus");
    url.searchParams.append("conferenceName", conference.id);
    url.searchParams.append("agentNumber", this.number);

    return url.toString();
  }

  // Should be self-explanitory
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

// Handles our agents. This allows a situation where two people can call and two people can accept,
// distributing to our free agents
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
    // Load up our agents
    for (const k in AGENTS) {
      this.agents[k] = new Agent(k, AGENTS[k]);
    }

    // Trigger whan a conference is fully connected to an agent
    this.on("accepted", (conf, agent) => {
      console.log("DEBUG:", "Conf", conf.id, "accepted by", agent.name);
      // Remove the conference from the queue
      this.queue = this.queue.filter((c) => c.id !== conf.id);
      // free up all attached agents that aren't the one that accepts
      const freedAgents = conf.attachedAgents.filter(
        (a) => a.number !== agent.number,
      );
      // Leave only the one that accepted
      conf.attachedAgents = conf.attachedAgents.filter(
        (a) => a.number === agent.number,
      );
      // End calls and run agent-level cleanup
      for (const freedAgent of freedAgents) {
        freedAgent.clean();
      }
    });

    // Runs on the end of a conference
    this.on("cleanup", (conf) => {
      console.log("DEBUG:", "Running agent cleanup on", conf.id);
      // Removes any lingering agents
      for (const agent of conf.attachedAgents) {
        agent.clean();
      }
      // and the conference from the queue
      this.queue = this.queue.filter((c) => c.id !== conf.id);
    });

    // When an agent is not in a call, see if there's any other calls for them to join
    this.on("freed", this.callAvailable);
  }

  // Return agents who do not have a call associated to them
  public get freeAgents() {
    return Object.entries(this.agents)
      .filter(([, info]) => !info.call)
      .map(([, info]) => info);
  }

  // Add conference to queue and call if available
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
    // Get the longest-waiting customer
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

// A "Conference" is an instance of a customer calling us
class Conference {
  // Internal ID
  id: string;
  // Refers to the conference itself
  internalConferenceId?: string;
  baseUrl: string;
  attachedAgents: Agent[];
  // Is an agent connected to the client?
  live: boolean;
  callerNumber: string;
  answeringMachineCallback?: ReturnType<typeof setTimeout>;
  // Whether or not this is in voicemail
  voiceMail: boolean;

  constructor(baseUrl: string, conferenceName: string, callerNumber: string) {
    this.id = conferenceName;
    this.baseUrl = baseUrl;
    this.attachedAgents = [];
    this.live = false;
    this.callerNumber = callerNumber;
    this.voiceMail = false;
    this.internalConferenceId = undefined;
    console.log(`DEBUG: New conference = ${this.id}`);
    // Register self in global state
    activeConferences.set(this.id, this);
  }

  // Unregister this conference from the system and disconnect everyone involved
  cleanup() {
    clearTimeout(this.answeringMachineCallback);

    activeConferences.delete(this.id);
    AgentPool.emit("cleanup", this);
  }

  // Since we carry state in URL params, this abstracts it out some to ensure it's always formed correctly
  actionUrl<T extends Action>(action: T, data: ActionParams[T]) {
    const url = new URL(`${this.baseUrl}/call`);
    // Always include what the action is and what conference this refers to
    url.searchParams.append("conferenceName", this.id);
    url.searchParams.append("action", action);
    // And add whatever else is needed
    for (const [k, v] of Object.entries(data)) {
      url.searchParams.append(k, v);
    }
    return url.toString();
  }

  // Start the call. Logs to Slack and move the customer into a Twilio conference
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
        waitUrl: HOLD_MUSIC, // ring sound for incoming caller while they connect
        waitMethod: "GET",
        statusCallback: this.actionUrl(Action.CONFERENCE_STATUS, {}),
        statusCallbackEvent: ["start", "join"],
      },
      this.id,
    );

    // send to the answering machine in 30 seconds
    this.answeringMachineCallback = setTimeout(
      this.answeringMachine.bind(this),
      30 * 1000,
    );

    console.log("DEBUG: Triggering independent API calls for each agent");
    // Add this conference into the queue for our agents
    AgentPool.submitConference(this);
    return response;
  }

  async answeringMachine() {
    if (!this.live && this.internalConferenceId) {
      console.log("DEBUG: Sending to voicemail:", this.id);
      this.voiceMail = true;

      const response = new twiml.VoiceResponse();
      response.say(
        "Unfortunately, our agents are busy at this time. Please leave a message on the beep.",
      );
      response.record({
        action: this.actionUrl(Action.RECORDING, {}),
        playBeep: true,
      });
      // Stop attempting to ring
      AgentPool.emit("cleanup", this);

      await twilioClient.calls.get(this.id).update({
        twiml: response,
      });
    }
  }

  // Triggered when the customer hangs up
  async finished(bypass = false, url = "") {
    const response = new twiml.VoiceResponse();
    if (this.voiceMail && !bypass) {
      return response;
    }

    if (this.live) {
      await axios.post(SLACK_WEBHOOK_URL, {
        text: `✅ Finished call from ${this.callerNumber}`,
      });
    } else {
      const recording = new URL(this.baseUrl + "/recording");
      recording.searchParams.set("url", url);

      await axios.post(SLACK_WEBHOOK_URL, {
        text: `❌ Missed call from ${this.callerNumber} ${url ? `<${recording.toString()}|Voice Message>` : ""}`,
      });
    }
    this.cleanup();
    response.hangup();
    return response;
  }

  async agentWhisper(event: any, query: ActionParams["whisper"]) {
    const response = new twiml.VoiceResponse();
    // Fallback in case two people pick up and one doesn't get ended
    if (this.live) {
      console.log("DEBUG", "Call answered by coworker.", this.attachedAgents);
      response.say("Call answered by coworker");
      response.hangup();
      return response;
    }

    // Poll for "1"
    const gather = response.gather({
      numDigits: 1,
      action: this.actionUrl(Action.ANSWERED, { agentNumber: event.To }),
      // short timeout so the "incoming agent call" loops
      timeout: 2,
    });

    // Loop
    gather.say("Incoming agent call. Press 1 to connect.");
    response.redirect(
      this.actionUrl(Action.WHISPER, {
        agentNumber: query.agentNumber,
      }),
    );

    return response;
  }

  // Trigger when agent presses a button during the "whisper" phase
  async agentAction(
    event: any,
    query: {
      agentNumber: string;
    },
  ) {
    const response = new twiml.VoiceResponse();
    const agent = AgentPool.getByNumber(event.To);

    // Fallback if pickup collision
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
      // If no active conference is found, the caller has already left :-(
      // This probably does not trigger due to clean up on hangup
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

      // Set the call as active
      this.live = true;

      console.log(`DEBUG: ${agent.name} joined ${this.id}`);
      response.dial().conference(
        {
          startConferenceOnEnter: true,
          endConferenceOnExit: false, // Agent leaving doesn't kill the call
        },
        this.id,
      );

      // Kill all OTHER agent calls so their phones stop ringing
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

// Used for ending a call if the agent hangs up
app.post("/agentStatus", async (req: Request, res: Response) => {
  const event: any = req.body;
  const { conferenceName, agentNumber } = req.query;
  const conference = activeConferences.get(conferenceName as string);
  // Is the call accepted and connected, is this status update a normal hangup, and is the one hanging up the singular agent assigned
  if (
    conference?.live &&
    event?.CallStatus === "completed" &&
    conference.attachedAgents.filter((x) => x.number === agentNumber).length ===
      1
  ) {
    await twilioClient.calls.get(conference.id).update({
      status: "completed",
    });
  }

  return res.send("");
});

const buildUrl = (req: Request) => {
  const proto = req.headers?.["x-forwarded-proto"] ?? req.protocol;
  const host =
    req.headers?.["x-forwarded-host"] ?? req.headers?.["host"] ?? req.host;
  return new URL(`${proto}://${host}`).toString();
};

// Endpoint for Twilio calls
app.post("/call", async (req: Request, res: Response) => {
  const baseUrl = buildUrl(req);
  const event: any = req.body;
  const rawAction = req.query["action"];
  const action = typeof rawAction === "string" ? rawAction : "";

  const conferenceName = req.query?.conferenceName as string;
  const conference = activeConferences.get(conferenceName);

  console.log(`DEBUG: params = `, req.query);
  console.log(`DEBUG: event = ${JSON.stringify(event, null, 2)}`);

  try {
    if (action === Action.WHISPER) {
      console.log("DEBUG: Whisper Logic: agent answers");
      if (!conference) {
        throw new Error("ERROR: conferenceName missing");
      }

      const response = await conference.agentWhisper(event, req.query as any);
      res.type("text/xml").send(response.toString());
      return;
    }

    // Agent button pressing logic
    if (action === Action.ANSWERED) {
      console.log("DEBUG: Agent button pressing logic");
      if (!conference) {
        throw new Error("CRITICAL: conferenceName missing");
      }
      const response = await conference.agentAction(event, req.query as any);
      res.type("text/xml").send(response.toString());
      return;
    }

    // Finished call logic
    if (action === Action.FINISHED) {
      console.log(`DEBUG: Finished call path`);
      if (!conference) {
        throw new Error("CRITICAL: conferenceName missing");
      }
      const response = await conference.finished(false);

      res.type("text/xml").send(response.toString());
      return;
    }

    if (action === Action.CONFERENCE_STATUS) {
      if (conference) {
        // Log the id of the conference (twilio's concept)
        conference.internalConferenceId = event["ConferenceSid"];
      }
      res.send();
      return;
    }

    if (action === Action.RECORDING) {
      if (conference) {
        // If we get a recording, end the call for once and all
        const response = await conference.finished(true, event["RecordingUrl"]);

        res.type("text/xml").send(response.toString());
      } else {
        res.send();
      }
      return;
    }

    // Fresh call (no DialStatus yet)
    if (!event.DialStatus) {
      // Start a call
      const conference = new Conference(baseUrl, event.CallSid, event.To);
      const resp = conference.initialize(event);

      // IMMEDIATELY send TwiML back so the caller enters the room
      res.type("text/xml").send(resp.toString());
      return;
    }

    // Null fallback
    const response = new twiml.VoiceResponse();
    console.error(`DEBUG: unknown state action = ${action}`);
    res.type("text/xml").send(response.toString());
  } catch (error: unknown) {
    console.error(error);
    res.status(500).send("Error processing TwiML");
  }
});

// Proxies recordings from Twilio
app.get("/recording", async (req, res) => {
  const url = new URL(req.query["url"] as string);
  if (url.host !== "api.twilio.com") {
    return res.status(403).send();
  }
  const resp = await axios.get(url.toString() + ".mp3", {
    auth: {
      username: TWILIO_SID,
      password: TWILIO_TOKEN,
    },
    responseType: "arraybuffer",
  });
  // Try to avoid malicious usage
  if (resp.status !== 200 || resp.headers["content-type"] !== "audio/mpeg") {
    return res.status(403).send();
  }

  res.status(resp.status).contentType("audio/mpeg").send(resp.data);
});

app.listen(PORT, (): void => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
  console.log(`Point your Twilio call webhook to /call`);
});
