// src/contract.ts
import { Store } from "@subsquid/typeorm-store";
import { ethers } from "ethers";
import * as erc721 from "./abi/erc721";
import { Contract } from "./model";

export const CHAIN_NODE = "wss://rpc.pinknode.io/astar/0cac53c9-2bc5-440f-9f3b-9e2307c46d60";

export const contractMapping: Map<string, Contract> = new Map<
  string,
  Contract
>();
