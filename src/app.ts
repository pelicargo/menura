import express, { Request, Response } from "express";
import bodyParser from "body-parser";
import twilio from "twilio";
import axios from "axios";
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

const SLACK_WEBHOOK_URL: string = getEnv("SLACK_WEBHOOK_URL");
const PORT: number = Number(getEnv("PORT")) || 3000;
const TWILIO_SID: string = getEnv("TWILIO_SID");
const TWILIO_TOKEN: string = getEnv("TWILIO_TOKEN");
const AGENTS: Record<string, string> = {
  "+15551234567": "Agent Name",
};

// Local db of which calls were answered by any agent
const answeredConferences: Set<string> = new Set<string>();

// Create Twilio client for Twilio Conferences
const twilioClient = twilio(TWILIO_SID, TWILIO_TOKEN);

// Endpoint for Twilio calls
app.post("/call", async (req: Request, res: Response): Promise<void> => {
  const baseUrl = `${req.protocol}://${req.get("host")}`;

  const response: twilio.twiml.VoiceResponse = new twiml.VoiceResponse();
  const event: any = req.body;
  const rawAction = req.query["action"];
  const action: string = typeof rawAction === "string" ? rawAction : "";

  console.log(`DEBUG: action = ${action}`);
  console.log(`DEBUG: event = ${JSON.stringify(event, null, 2)}`);

  try {
    if (action === "whisper") {
      console.log("DEBUG: Whisper Logic: agent answers");
      const conferenceName: string =
        (req.query.conferenceName as string) ||
        (() => {
          throw new Error("CRITICAL: conferenceName missing");
        })();
      const gather: InstanceType<typeof twiml.VoiceResponse.Gather> =
        response.gather({
          numDigits: 1,
          action: `${baseUrl}/call?action=answered&agentNumber=${event.To}&conferenceName=${conferenceName}`,
          // short timeout so the "incoming agent call" loops
          timeout: 2,
        });
      gather.say("Incoming agent call. Press 1 to connect.");
      response.redirect(
        `${baseUrl}/call?action=whisper&conferenceName=${conferenceName}`,
      );
      res.type("text/xml").send(response.toString());
      return;
    }

    // Agent button pressing logic
    if (action === "answered") {
      console.log("DEBUG: Agent button pressing logic");
      const conferenceName: string =
        (req.query.conferenceName as string) ||
        (() => {
          throw new Error("CRITICAL: conferenceName missing");
        })();
      if (event.Digits === "1") {
        console.log("DEBUG: Call connected by agent by pressing 1");

        console.log("DEBUG: Checking if the caller is still there");
        const conferences = await twilioClient.conferences.list({
          friendlyName: conferenceName,
          status: "in-progress", // Only look for active ones
          limit: 1,
        });
        // If no active conference is found, the caller has already left :-()
        if (conferences.length === 0) {
          answeredConferences.delete(conferenceName);
          console.log("DEBUG: caller hung up before agent could join");
          response.say("I'm sorry: the caller has already hung up. Good bye!");
          response.hangup();
          res.type("text/xml").send(response.toString());
          return;
        }

        const agentNumber: string =
          (req.query.agentNumber as string) ||
          (() => {
            throw new Error("CRITICAL: agentNumber missing");
          })();

        await axios.post(SLACK_WEBHOOK_URL, {
          text: `✅ Call answered by agent: ${agentNumber}`,
        });

        answeredConferences.add(conferenceName);

        console.log("DEBUG: Join THIS agent to the conference");
        console.log(`DEBUG: conferenceName = ${conferenceName}`);
        response.dial().conference(
          {
            startConferenceOnEnter: true,
            endConferenceOnExit: false, // Agent leaving doesn't kill the call
          },
          conferenceName,
        );

        // Kill all OTHER agent calls so their phones stop ringing
        // We look for calls to our agent numbers that are still 'queued' or 'ringing'
        console.log("DEBUG: killing other agent calls");

        const activeCalls = await twilioClient.calls.list({
          status: "ringing",
        });

        for (const call of activeCalls) {
          // Only cancel calls that were part of this specific conference attempt
          // (You'd ideally track these SIDs in a small cache or check the 'To' number)
          if (
            Object.keys(AGENTS).includes(call.to) &&
            call.to !== agentNumber
          ) {
            await twilioClient.calls(call.sid).update({ status: "completed" });
          }
        }

        res.type("text/xml").send(response.toString());
        return;
      } else {
        console.log("DEBUG: Agent pressed not-1");
        // Redirect back to the whisper logic to repeat the prompt
        response.redirect(
          `${baseUrl}/call?action=whisper&conferenceName=${conferenceName}`,
        );
        res.type("text/xml").send(response.toString());
        return;
      }
    }

    // Finished call logic
    if (action === "finished") {
      console.log(`DEBUG: Finished call path`);
      const conferenceName: string =
        (req.query.conferenceName as string) ||
        (() => {
          throw new Error("CRITICAL: conferenceName missing");
        })();

      // Check if this is a not missed call
      const isFinishedCall = answeredConferences.has(conferenceName);

      if (isFinishedCall) {
        await axios.post(SLACK_WEBHOOK_URL, {
          text: `✅ Finished call from ${event.From}`,
        });
      } else {
        await axios.post(SLACK_WEBHOOK_URL, {
          text: `❌ Missed call from ${event.From}`,
        });
      }

      // cleanup
      answeredConferences.delete(conferenceName);
      res.type("text/xml").send(response.toString());
      return;
    }

    // Fresh call (no DialStatus yet)
    if (!event.DialStatus) {
      console.log("DEBUG: Initial Caller / Dial Logic");
      await axios.post(SLACK_WEBHOOK_URL, {
        text: `☎️ Incoming call to number from: ${event.From}`,
      });

      console.log(
        "DEBUG: Put the incoming caller into a unique Conference room",
      );
      const conferenceName: string = `Conf_${event.CallSid}`;
      console.log(`DEBUG: conferenceName = ${conferenceName}`);
      const dial: InstanceType<typeof twilio.twiml.VoiceResponse.Dial> =
        response.dial({
          // This tells Twilio: "When this Dial is done, call this URL"
          action: `${baseUrl}/call?action=finished&conferenceName=${conferenceName}`,
        });
      dial.conference(
        {
          startConferenceOnEnter: true,
          endConferenceOnExit: true,
          waitUrl: "http://api.twilio.com/cowbell.mp3", // ring sound for incoming caller
        },
        conferenceName,
      );

      console.log("DEBUG: Triggering independent API calls for each agent");
      // This is what keeps other agents ringing if one goes to voicemail
      Object.keys(AGENTS).forEach((num: string) => {
        twilioClient.calls
          .create({
            to: num,
            from: event.To,
            url: `${baseUrl}/call?action=whisper&conferenceName=${conferenceName}`,
          })
          .catch((err) => console.error(`Failed to dial agent ${num}:`, err));
      });

      // IMMEDIATELY send TwiML back so the caller enters the room
      res.type("text/xml").send(response.toString());
      return;
    }

    console.error(`DEBUG: unknown state action = ${action}`);
    res.type("text/xml").send(response.toString());
  } catch (error: unknown) {
    console.error(error);
    res.status(500).send("Error processing TwiML");
  }
});

app.listen(PORT, (): void => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
  console.log(`Point your Twilio call webhook to /call`);
});
