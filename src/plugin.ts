import streamDeck from "@elgato/streamdeck";

import { NetworkLatencyMonitor } from "./actions/network-latency";

// Use streamDeck.logger.{trace,info,warn,error} for logs.

// Register the network latency monitor action
streamDeck.actions.registerAction(new NetworkLatencyMonitor());

// Finally, connect to the Stream Deck.
streamDeck.connect();
