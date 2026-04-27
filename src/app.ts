import express, { Request, Response } from "express";
import { readFileSync } from "fs";
import bodyParser from "body-parser";
import twilio from "twilio";
import axios from "axios";
import { CallInstance } from "twilio/lib/rest/api/v2010/account/call.js";
import { config } from "dotenv";
import { EventEmitter } from "events";
import { scryptSync } from "crypto";
import { z } from "zod";
import { TZDate } from "@date-fns/tz";
import { isWithinInterval, parse } from "date-fns";
import { PhoneNumberInstance } from "twilio/lib/rest/lookups/v2/phoneNumber.js";
import VoiceResponse from "twilio/lib/twiml/VoiceResponse.js";

config();

const { twiml } = twilio;

function getEnv(name: string, extra = ""): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Environment variable ${name} is missing! ${extra}`);
  }
  return value;
}

const app: express.Express = express();

// Allow X-Forwarded-* headers
app.set("trust proxy", true);

// Twilio sends data as URL-encoded forms
app.use(bodyParser.urlencoded({ extended: false }));

const SLACK_WEBHOOK_URL = getEnv("SLACK_WEBHOOK_URL");
const PORT = Number(getEnv("PORT")) || 3000;
const TWILIO_SID = getEnv("TWILIO_SID");
const TWILIO_TOKEN = getEnv("TWILIO_TOKEN");
const HOLD_MUSIC = getEnv("HOLD_MUSIC");
const ADMIN_PASS = getEnv("ADMIN_PASS");
const TEAMS = getEnv("TEAMS")
  .split(",")
  .map((x) => x.trim());
const COMPANY_NAME = getEnv("COMPANY_NAME");

const agentSchema = z.object({
  label: z.string(),
  prefix: z.string().regex(/^[0-9]{4}$/),
  team: z.array(z.enum(TEAMS)),
  enabled: z.boolean(),
  timeZone: z.string(),
  slackId: z.string(),
  hours: z
    .array(
      z.array(
        z.object({
          start: z.iso.time(),
          end: z.iso.time(),
        }),
      ),
    )
    .min(7)
    .max(7),
});

type AgentSchema = z.infer<typeof agentSchema>;

const agentFile = z.record(z.e164(), agentSchema);

const defaultAgent = {
  enabled: true,
  label: "New Agent",
  prefix: "0000",
  slackId: "",
  team: [TEAMS[0]],
  timeZone: "Etc/UTC",
  hours: [[], [], [], [], [], [], []],
} satisfies z.infer<typeof agentSchema>;

const AGENTS = agentFile.parse(
  JSON.parse(readFileSync("agents.json", { encoding: "utf-8" })),
);

const validatePassword = (password: string) => {
  const [goodHash, salt] = ADMIN_PASS.split("$");
  const passHash = scryptSync(password, salt, 32).toString("hex");
  // Primitivie comparison, no need for timing safe
  return goodHash === passHash;
};

const slackLog = async (
  text: string,
  mention?: {
    mention: string;
    mention_text: string;
  },
) => {
  await axios.post(SLACK_WEBHOOK_URL, {
    text: text,
    ...(mention ?? {}),
  });
};

// Actions handled by the system. No action usually indicates a new call
enum Action {
  // Whisper is the event where the agent can press 1 to accept
  WHISPER = "whisper",
  ANSWERED = "answered",
  // Triggered when a call ends
  FINISHED = "finished",
  CONFERENCE_STATUS = "conferenceStatus",
  RECORDING = "recording",
  INITIALIZE = "initialize",
  IVR = "ivr",
  DIRECT = "direct",
  TRANSFER = "transfer",
  WAIT = "wait",
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
  [Action.IVR]: {
    team?: string;
  };
  [Action.INITIALIZE]: {
    team: string;
  };
  [Action.DIRECT]: {};
  [Action.TRANSFER]: {};
  [Action.WAIT]: {};
};

// Represents someone who answers calls
class Agent {
  // We don't need the call info immediately, so we can store it as a promise for when it is needed to avoid unnecessary await
  call: Promise<CallInstance> | null;
  number: string;
  name: string;
  teams: string[];
  prefix: string;
  hours: AgentSchema["hours"];
  enabled: boolean;
  timeZone: string;
  slackId: string;

  constructor(number: string, info: AgentSchema) {
    this.call = null;
    this.number = number;
    this.name = info.label;
    this.teams = info.team;
    this.hours = info.hours;
    this.enabled = info.enabled;
    this.prefix = info.prefix;
    this.timeZone = info.timeZone;
    this.slackId = info.slackId;
  }

  isOnCall() {
    const converted = new TZDate(new Date(), this.timeZone);
    const hours = this.hours[converted.getDay()];
    for (const range of hours) {
      const start = parse(range.start, "HH:mm", converted);
      const end = parse(range.end, "HH:mm", converted);
      if (
        isWithinInterval(converted, {
          start,
          end,
        })
      ) {
        return true;
      }
    }
    return false;
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
      from: conference.calledNumber,
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
  transfer: [Conference, string]; // Prefix
}> {
  agents: Record<string, Agent>;
  queue: Conference[];
  constructor() {
    super();
    this.agents = {};
    this.queue = [];
    // Load up our agents
    for (const k of Object.keys(AGENTS)) {
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

    this.on("transfer", (conf, agentPrefix) => {
      const agent = this.getAgentByPrefix(agentPrefix);
      conf.attachedAgents.push(agent);
      if (agent.call === null) {
        agent.startCall(conf);
      }
    });

    // Runs on the end of a conference
    this.on("cleanup", (conf) => {
      console.log("DEBUG:", "Running agent cleanup on", conf.id);
      // Removes any lingering agents
      for (const agent of conf.attachedAgents) {
        agent.clean();
      }
      conf.attachedAgents = [];
      // and the conference from the queue, just to be safe
      this.queue = this.queue.filter((c) => c.id !== conf.id);
    });

    // When an agent is not in a call, see if there's any other calls for them to join
    this.on("freed", this.callAvailable);
  }

  // Return agents who do not have a call associated to them
  public get freeAgents() {
    return Object.values(this.agents)
      .filter((info) => !info.call)
      .map((info) => info);
  }

  getAgentByPrefix(prefix?: string) {
    const filtered = Object.values(this.agents).filter(
      (agent) => agent.prefix === prefix,
    );
    return filtered?.[0];
  }

  // Add conference to queue and call if available
  submitConference(conference: Conference) {
    this.queue.push(conference);
    this.callAvailable();
  }

  callAvailable() {
    console.log("Calling available agents: ", this.freeAgents, this.queue);
    // process potential direct calls
    for (const conf of activeConferences.values()) {
      const agent = conf.attachedAgents?.[0];
      if (conf.attachedAgents.length === 1 && !agent.call && agent.isOnCall()) {
        const agent = conf.attachedAgents[0];
        agent.startCall(conf);
        conf.attachedAgents.push(agent);
      }
    }

    if (this.queue.length === 0) {
      // nothin' to do
      return;
    }
    // Get the longest-waiting customer
    const current = this.queue[0];

    const free = this.freeAgents;
    for (const freeAgent of free) {
      if (
        freeAgent.isOnCall() &&
        freeAgent.teams.includes(current.teamTarget ?? "")
      ) {
        freeAgent.startCall(current);
        current.attachedAgents.push(freeAgent);
      } else {
        console.log(
          `[DEBUG] ${freeAgent.name} does not match: `,
          freeAgent.isOnCall(),
          freeAgent.teams.includes(current.teamTarget ?? ""),
          freeAgent.teams,
          current.teamTarget,
        );
      }
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
  calledNumber: string;
  callerNumber: string;
  answeringMachineCallback?: ReturnType<typeof setTimeout>;
  // Whether or not this is in voicemail
  voiceMail: boolean;

  teamTarget?: string;
  agentTargetPrefix?: string;
  callerId?: PhoneNumberInstance;
  onHold: boolean;

  constructor(
    baseUrl: string,
    conferenceName: string,
    calledNumber: string,
    callerNumber: string,
  ) {
    this.id = conferenceName;
    this.onHold = false;
    this.baseUrl = baseUrl;
    this.attachedAgents = [];
    this.live = false;
    this.calledNumber = calledNumber;
    this.callerNumber = callerNumber;
    this.voiceMail = false;
    this.internalConferenceId = undefined;
    this.callerId = undefined;
    console.log(`DEBUG: New conference = ${this.id}`);
    // Register self in global state
    activeConferences.set(this.id, this);
  }

  // Unregister this conference from the system and disconnect everyone involved
  cleanup() {
    this.stopAnsweringMachine();

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

  async fetchCallerId() {
    try {
      this.callerId = await twilioClient.lookups.v2
        .phoneNumbers(this.callerNumber)
        .fetch({ fields: "caller_name" });
    } catch (e) {
      console.error("[ERROR]: Couldn't get caller id: ", e);
    }
  }

  identifyCaller() {
    return (
      (this.callerId?.callerName?.callerName ?? "") +
      " " +
      (this.callerId?.nationalFormat
        ? this.callerId?.callingCountryCode +
          " " +
          this.callerId?.nationalFormat
        : this.callerNumber)
    ).trim();
  }

  ivrMenu(event: any) {
    console.log(`[DEBUG]: IVR started for ${this.callerNumber}`);
    const response = new twiml.VoiceResponse();
    const digits = event?.Digits;
    if (digits != undefined) {
      const parsed = parseInt(digits);
      if (digits === 0) {
        // continue on...
      } else if (digits === "#") {
        response.redirect(this.actionUrl(Action.DIRECT, {}));
        return response;
      } else if (!isNaN(parsed) && TEAMS[parsed - 1]) {
        response.redirect(
          this.actionUrl(Action.INITIALIZE, {
            team: TEAMS[parsed - 1],
          }),
        );
        return response;
      } else {
        response.say("Unknown team.");
      }
    }
    // don't spam if looping
    if (event.CallStatus === "ringing") {
      console.log("DEBUG: Initial Caller / Dial Logic");
      slackLog(`☎️ ${this.identifyCaller()}: Incoming call`);
    }

    const teamMessage = TEAMS.map(
      (team, i) => `For the ${team} team, press ${i + 1}`,
    );

    const gather = response.gather({
      action: this.actionUrl(Action.IVR, {}),
      numDigits: 1,
      timeout: 30,
      finishOnKey: "0",
    });
    gather.say(
      `Welcome to ${COMPANY_NAME}! ${teamMessage.join(". ")}. If you know the extension of the agent you would like to talk to, please press pound. To repeat these options, press 0.`,
    );

    response.redirect(this.actionUrl(Action.IVR, {}));
    return response;
  }

  direct(event: any) {
    const response = new twiml.VoiceResponse();
    const agent = AgentPool.getAgentByPrefix(event?.Digits);
    if (!event?.Digits) {
      response
        .gather({
          numDigits: 4,
          action: this.actionUrl(Action.DIRECT, {}),
        })
        .say(
          "Please enter the 4 digit extension of the agent you want to contact",
        );
      response.redirect(this.actionUrl(Action.IVR, {}));
      return response;
    } else if (!agent) {
      response.say("Unknown agent.");
      response.redirect(this.actionUrl(Action.IVR, {}));
      return response;
    } else {
      const dial = response.dial({
        action: this.actionUrl(Action.FINISHED, {}),
      });
      this.agentTargetPrefix = agent.prefix;
      slackLog(`⏩️ ${this.identifyCaller()} calling ${agent.toString()}`);

      dial.conference(
        {
          startConferenceOnEnter: true,
          endConferenceOnExit: true,
          waitUrl: HOLD_MUSIC, // ring sound for incoming caller while they connect
          waitMethod: "GET",
          statusCallback: this.actionUrl(Action.CONFERENCE_STATUS, {}),
          statusCallbackEvent: ["start", "join"],
          participantLabel: this.callerNumber,
        },
        this.id,
      );

      // send to the answering machine in 30 seconds
      this.startAnsweringMachine();

      this.attachedAgents.push(agent);
      AgentPool.callAvailable();
      return response;
    }
  }

  // Start the call. Logs to Slack and move the customer into a Twilio conference
  initialize({ team }: ActionParams["initialize"]) {
    const response = new twiml.VoiceResponse();
    this.teamTarget = team;

    console.log(
      "DEBUG: Put the incoming caller into a unique Conference room, targeting",
      team,
    );
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
        participantLabel: this.callerNumber,
      },
      this.id,
    );

    // send to the answering machine in 30 seconds
    this.startAnsweringMachine();

    console.log("DEBUG: Triggering independent API calls for each agent");
    // Add this conference into the queue for our agents
    AgentPool.submitConference(this);
    return response;
  }

  startAnsweringMachine() {
    // send to the answering machine in 30 seconds
    this.answeringMachineCallback = setTimeout(
      this.answeringMachine.bind(this),
      30 * 1000,
    );
  }

  stopAnsweringMachine() {
    clearTimeout(this.answeringMachineCallback);
  }

  async answeringMachine() {
    if (!this.live && this.internalConferenceId) {
      console.log("DEBUG: Sending to voicemail:", this.id);
      const targeted = AgentPool.getAgentByPrefix(this.agentTargetPrefix);

      slackLog(
        `❌ ${this.identifyCaller()} sent to voicemail`,
        targeted?.slackId
          ? {
              mention: targeted.slackId,
              mention_text: "Was directly calling: ",
            }
          : undefined,
      );
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
      slackLog(`✅ ${this.identifyCaller()} finished call`);
    } else {
      const recording = new URL(this.baseUrl + "/recording");
      recording.searchParams.set("url", url);
      const targeted = AgentPool.getAgentByPrefix(this.agentTargetPrefix);

      slackLog(
        `❌ Missed call from [${this.identifyCaller()}] ${url ? `| Voicemail URL: ${recording.toString()}` : ""}`,
        targeted?.slackId
          ? {
              mention: targeted.slackId,
              mention_text: "Was directly calling: ",
            }
          : undefined,
      );
    }
    this.cleanup();
    response.hangup();
    return response;
  }

  async agentWhisper(event: any, query: ActionParams["whisper"]) {
    const response = new twiml.VoiceResponse();
    // Fallback in case two people pick up and one doesn't get ended
    if (this.live && query["agentNumber"] != this.attachedAgents?.[0]?.number) {
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
    gather.say(
      `Incoming call from ${this.identifyCaller()}. Press 1 to connect.`,
    );
    response.redirect(
      this.actionUrl(Action.WHISPER, {
        agentNumber: query.agentNumber,
      }),
    );

    return response;
  }

  async agentTransfer(event: any) {
    const response = new twiml.VoiceResponse();
    if (
      event.Digits === "####" ||
      event.Digits === this.attachedAgents[0].prefix
    ) {
      this.stopHold();
      this.joinAgentResponse(response);
      return response;
    } else if (event.Digits?.length === 4) {
      const validAgent = AgentPool.getAgentByPrefix(event.Digits);
      if (validAgent) {
        // Disassociate
        const thisAgent = this.attachedAgents[0];
        this.attachedAgents = [];
        AgentPool.emit("transfer", this, validAgent.prefix);
        await thisAgent.clean();
        this.live = false;
        this.startAnsweringMachine();
        this.agentTargetPrefix = validAgent.prefix;

        slackLog(
          `⏩ ${this.identifyCaller()} transferred to ${validAgent.toString()}`,
        );
        return response;
      } else {
        response.say("Unknown agent.");
      }
    }

    this.startHold();

    response
      .gather({
        numDigits: 4,
        action: this.actionUrl(Action.TRANSFER, {}),
        finishOnKey: "",
        timeout: 10,
      })
      .say(
        "Enter 4 digit code of agent, or press pound 4 times to return to call",
      );
    response.redirect(this.actionUrl(Action.TRANSFER, {}));
    return response;
  }

  async startHold() {
    if (!this.onHold) {
      this.onHold = true;
      // We have the ICI by this point, we just need to appease TS
      await twilioClient.conferences
        .get(this.internalConferenceId ?? "")
        .participants.get(this.callerNumber)
        .update({
          hold: true,
          holdUrl: HOLD_MUSIC,
        });
    }
  }

  async stopHold() {
    if (this.onHold) {
      this.onHold = false;
      // We have the ICI by this point, we just need to appease TS
      await twilioClient.conferences
        .get(this.internalConferenceId ?? "")
        .participants.get(this.callerNumber)
        .update({
          hold: false,
        });
    }
  }

  joinAgentResponse(response: VoiceResponse) {
    response
      .dial({
        hangupOnStar: true,
      })
      .conference(
        {
          startConferenceOnEnter: true,
          endConferenceOnExit: false, // Agent leaving doesn't kill the call
        },
        this.id,
      );
    response.redirect(this.actionUrl(Action.TRANSFER, {}));
  }

  // Trigger when agent presses a button during the "whisper" phase
  async agentAnswer(
    event: any,
    query: {
      agentNumber: string;
    },
  ) {
    const response = new twiml.VoiceResponse();
    const agent = AgentPool.getByNumber(event.To);

    if (event.Digits === "1") {
      console.log("DEBUG: Call connected to", agent.toString());

      this.stopHold();
      this.stopAnsweringMachine();

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

      // Set the call as active
      this.live = true;

      console.log(`DEBUG: ${agent.name} joined ${this.id}`);
      this.joinAgentResponse(response);
      slackLog(`✅ ${this.identifyCaller()} answered by ${agent.toString()}`);

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
  const baseUrl = new URL(process.env.ROOT_URL || buildUrl(req));
  if (
    !twilio.validateIncomingRequest(req, TWILIO_TOKEN, {
      host: baseUrl.host,
      protocol: baseUrl.protocol,
      url: baseUrl.toString().replace(/\/$/, "") + req.url,
    })
  ) {
    res.sendStatus(403);
    return;
  }
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
  const baseUrl = new URL(process.env.ROOT_URL || buildUrl(req));

  if (
    !twilio.validateIncomingRequest(req, TWILIO_TOKEN, {
      host: baseUrl.host,
      protocol: baseUrl.protocol,
      url: baseUrl.toString().replace(/\/$/, "") + req.url,
    })
  ) {
    res.sendStatus(403);
    return;
  }
  const event: any = req.body;
  const rawAction = req.query["action"];
  const action = typeof rawAction === "string" ? rawAction : "";

  const conferenceName = req.query?.conferenceName as string;
  const conference = activeConferences.get(conferenceName);

  console.log(`DEBUG: params = `, req.query);
  console.log(`DEBUG: event = ${JSON.stringify(event, null, 2)}`);

  try {
    if (action === Action.INITIALIZE) {
      if (!conference) {
        throw new Error("ERROR: conference does not exist!");
      }
      const resp = conference.initialize(req.query as any);

      res.type("text/xml").send(resp.toString());
      return;
    }

    if (action === Action.WHISPER) {
      console.log("DEBUG: Whisper Logic: agent answers");
      if (!conference) {
        throw new Error("ERROR: conference does not exist!");
      }

      const response = await conference.agentWhisper(event, req.query as any);
      res.type("text/xml").send(response.toString());
      return;
    }

    // Agent button pressing logic
    if (action === Action.ANSWERED) {
      console.log("DEBUG: Agent button pressing logic");
      if (!conference) {
        throw new Error("CRITICAL: conference does not exist!");
      }
      const response = await conference.agentAnswer(event, req.query as any);
      res.type("text/xml").send(response.toString());
      return;
    }

    if (action === Action.TRANSFER) {
      console.log("Transferring...");
      if (!conference) {
        throw new Error("CRITICAL: conference does not exist!");
      }
      const response = await conference.agentTransfer(event);
      res.type("text/xml").send(response.toString());
      return;
    }

    if (action === Action.DIRECT) {
      if (!conference) {
        throw new Error("CRITICAL: conference does not exist!");
      }
      const response = conference.direct(event);
      res.type("text/xml").send(response.toString());
      return;
    }

    if (action === Action.WAIT) {
      if (!conference) {
        throw new Error("CRITICAL: conference does not exist!");
      }
      const response = new twiml.VoiceResponse();

      response.play(HOLD_MUSIC);

      res.type("text/xml").send(response.toString());
      return;
    }

    // Finished call logic
    if (action === Action.FINISHED) {
      console.log(`DEBUG: Finished call path`);
      if (!conference) {
        throw new Error("CRITICAL: conference does not exist!");
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

    // Fresh call or IVR loop
    if (!event.DialStatus || action === Action.IVR) {
      // Start a call
      const conf =
        conference ??
        new Conference(
          baseUrl.toString().replace(/\/$/, ""),
          event.CallSid,
          event.To,
          event.From,
        );
      if (conference === undefined) {
        await conf.fetchCallerId();
      }
      const resp = conf.ivrMenu(event);

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

const adminRoutes = express.Router();
adminRoutes.use(express.json());

// Bless https://stackoverflow.com/a/33905671
adminRoutes.use((req, res, next) => {
  const b64auth = (req.headers.authorization || "").split(" ")[1] || "";
  const [login, password] = Buffer.from(b64auth, "base64")
    .toString()
    .split(":");
  if (login && password && login === "menura" && validatePassword(password)) {
    return next();
  }
  res.set("WWW-Authenticate", 'Basic realm="401"'); // change this
  res.status(401).send("Authentication required."); // custom message
});

adminRoutes.get("/info", async (_, res) => {
  res.json({
    agents: AGENTS,
    teams: TEAMS,
    defaultAgent,
    timeZones: [...Intl.supportedValuesOf("timeZone"), "Etc/UTC"],
  });
});

adminRoutes.post("/test", async (req, res) => {
  const test = agentFile.safeParse(req.body);

  res.json({
    success: test.success,
    errors: test.error,
  });
});

adminRoutes.get("/manager", async (_, res) => {
  res.sendFile("manager.html", {
    root: "www",
  });
});

app.use("/admin", adminRoutes);

process.on("uncaughtException", console.error);

app.listen(PORT, (): void => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
  console.log(`Point your Twilio call webhook to /call`);
});
