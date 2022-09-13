// src/contract.ts
import { Store } from "@subsquid/typeorm-store";
import { ethers } from "ethers";
import * as erc721 from "./abi/erc721";
import { Contract } from "./model";

export const CHAIN_NODE = "wss://astar.api.onfinality.io/ws?apikey=70f02ff7-58b9-4d16-818c-2bf302230f7d";

export const contractMapping: Map<string, Contract> = new Map<
  string,
  Contract
>();
