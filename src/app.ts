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

// Replace these with your actual values or process.env
const SLACK_WEBHOOK_URL: string = getEnv("SLACK_WEBHOOK_URL");
const PORT: number = Number(getEnv("PORT")) || 3000;
const AGENTS: Record<string, string> = {
  "+15551234567": "Agent Name",
};

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
      const gather: InstanceType<typeof twiml.VoiceResponse.Gather> =
        response.gather({
          numDigits: 1,
          action: `${baseUrl}/call?action=answered&AgentNumber=${event.To}`,
          timeout: 240,
        });
      gather.say("Incoming agent call. Press 1 to connect.");
      response.hangup();
      res.type("text/xml").send(response.toString());
      return;
    }

    // Answered Logic (Agent pressed 1)
    if (action === "answered" && event.Digits === "1") {
      console.log("Call connected by agent");
      await axios.post(SLACK_WEBHOOK_URL, {
        text: `✅ Call answered by agent: ${event.AgentNumber}`,
      });
      res.type("text/xml").send(response.toString());
      return;
    }

    // Finished/Missed call logic
    if (action === "finished") {
      console.log(`DEBUG: missed call path`);
      const status = (event.DialCallStatus || "").toLowerCase();
      console.log(`DEBUG: status = ${status}`);

      const missedStatuses = ["no-answer", "busy", "failed", "canceled"];

      // Check if this is a missed call
      const isMissed =
        missedStatuses.includes(status) ||
        (status === "completed" && event.DialStatus !== "answered");

      if (isMissed) {
        await axios.post(SLACK_WEBHOOK_URL, {
          text: `❌ Missed call from ${event.From}. (Status: ${status})`,
        });
        res.type("text/xml").send(response.toString());
        return;
      } else {
        await axios.post(SLACK_WEBHOOK_URL, {
          text: `✅ Finished call from ${event.From}. (Status: ${status})`,
        });
        res.type("text/xml").send(response.toString());
        return;
      }
    }

    // If it's a fresh call (no DialStatus yet)
    if (!event.DialStatus) {
      console.log("DEBUG: Initial Caller / Dial Logic");
      await axios.post(SLACK_WEBHOOK_URL, {
        text: `☎️ Incoming call to number from: ${event.From}`,
      });
      const dial: InstanceType<typeof twiml.VoiceResponse.Dial> = response.dial(
        {
          timeout: 240,
          action: `${baseUrl}/call?action=finished`,
        },
      );

      Object.keys(AGENTS).forEach((num: string): void => {
        dial.number(
          {
            url: `${baseUrl}/call?action=whisper`,
          },
          num,
        );
      });
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
