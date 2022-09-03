// src/processor.ts
import { lookupArchive } from "@subsquid/archive-registry";
import { Store, TypeormDatabase } from "@subsquid/typeorm-store";
import {
  BatchContext,
  BatchProcessorItem,
  EvmLogEvent,
  SubstrateBatchProcessor,
  SubstrateBlock,
} from "@subsquid/substrate-processor";
import { In } from "typeorm";
import {
  CHAIN_NODE,
} from "./contract";
import { getWhitelistNFT } from "./helper/whitelistnftlist"
import { Owner, Token, Transfer, Contract } from "./model";
import * as erc721 from "./abi/erc721";
import { ethers } from "ethers";
import axios from "axios"

const database = new TypeormDatabase();
const processor = new SubstrateBatchProcessor()
  .setBatchSize(500)
  .setDataSource({
    chain: CHAIN_NODE,
    archive: lookupArchive("astar", { release: "FireSquid" }),
  })
  .setTypesBundle("astar")
  .addEvmLog(getWhitelistNFT(), {
    filter: [erc721.events["Transfer(address,address,uint256)"].topic],
  })

type Item = BatchProcessorItem<typeof processor>;
type Context = BatchContext<Store, Item>;

processor.run(database, async (ctx) => {
  const transfersData: TransferData[] = [];

  for (const block of ctx.blocks) {
    for (const item of block.items) {
      if (item.name === "EVM.Log") {
        // ctx.log.info(item.event.args?.address)
        const topics: string[] = item.event.args.topics;
        if (topics[0] === erc721.events["Transfer(address,address,uint256)"].topic) {
          ctx.log.info(`${item.event.args.address} ${block.header.height}`)
          const transfer = handleTransfer(block.header, item.event);
          if (transfer) transfersData.push(transfer);
        }
      }
    }
  }

  await saveTransfers(ctx, transfersData);
});

type TransferData = {
  id: string;
  from: string;
  to: string;
  token: string;
  timestamp: bigint;
  block: number;
  transactionHash: string;
  contractAddress: string;
};

type MetaData = {
  image?: string;
  image_alt?: string
}

async function isErc721 (ctx: Context, blockHeight: number, contractAddress: string): Promise<boolean> {
  
  const collection = await ctx.store.get(Contract, contractAddress)

  if (collection) return true
  
  const contract = new erc721.Contract(ctx, { height: blockHeight }, contractAddress);
  try {
    // check if ERC165 interface
    const checkERC165 = await contract.supportsInterface('0x01ffc9a7')
    if (checkERC165) {
      ctx.log.info(`Pass 165 ${contractAddress}`)
      // check if ERC721 interface
      const checkERC721 = await contract.supportsInterface('0x80ac58cd')
      if (checkERC721) {
        ctx.log.info(`Pass 721 ${contractAddress}`)
        try {
          const balance = await contract.balanceOf("0")
          ctx.log.info(`Balance: ${balance}`)
          return false
        } catch (error) {
          return true
        }
      } else {
        // ctx.log.error(`Gagal di 721 ${contractAddress}`);
        return false
      }
    } else {
      // ctx.log.error(`Gagal di 165 ${contractAddress}`);
      return false
    }
  } catch (error: any) {
    // ctx.log.error(`Gagal di General ${contractAddress} ${error}`);
    return false
  }
}

function collectionWithTokenId (collection: string, tokenId: string): string {
  return `${collection}-${tokenId}`
}

async function handleImage(tokenURI: string, ctx: Context) {
  try {
    // check if the URI is centralized of decentralizer
    // if its decentralized
    if (tokenURI.length === 0) return null
    if (tokenURI.includes("ipfs://")) {
      const { data: { image, image_alt } } = await axios.get<MetaData>(tokenURI.replace("ipfs://", "https://nftstorage.link/ipfs/"))

      if (image) return image
      if (image_alt) return image_alt
      ctx.log.error(`Data does not exist: ${image} ${image_alt}`)
      return null

    } else {

      const { data: { image, image_alt} } = await axios.get<MetaData>(tokenURI)

      if (image) return image
      if (image_alt) return image_alt
      ctx.log.error(`Data does not exist: ${image} ${image_alt}`)
      return null
    }
  } catch (error: any) {
    ctx.log.error(`fetching image error: ${error}`)
    return null
  }
}

async function handleChangeURI (
  ctx: Context, 
  oldURI: string, 
  blockHeight: number, 
  contractAddress: string,
  oldTokens: Map<string, Token>
) {
  let tokens: Map<string, Token> = new Map(
    (await ctx.store.findBy(Token, { uri: oldURI })).map((token) => [
      token.id,
      token,
    ])
  );

  ctx.log.warn(`Changing oldURI : ${oldURI}, tokens that have this uri is ${[...tokens.values()].length} from collection ${contractAddress}`)

  for (const tempToken of tokens) {
    const token = tempToken[1];
    ctx.log.warn(`handling changing token before : ${token.id} - ${token.uri} - ${token.imageUri} - ${token.oldUri}`)
    token.uri = await handleURI(ctx, blockHeight, contractAddress, token.tokenId.toString());
    token.oldUri = token.uri;
    token.imageUri = await handleImage(token.uri, ctx);
    ctx.log.warn(`handling changing token after : ${token.id} - ${token.uri} - ${token.imageUri} - ${token.oldUri}`)
    oldTokens.set(token.id, token);
  }

  return oldTokens;

}

async function handleURI (ctx: Context, height: number, contractAddress: string, tokenId: string): Promise<string> {
  try {
    const tokenContract = new erc721.Contract(ctx, { height }, contractAddress)
    return await tokenContract.tokenURI(ethers.BigNumber.from(tokenId)) 
  } catch (error: any) {
    ctx.log.error(`Error handling URI : ${error}`)
    return ""
  }
}

function handleTransfer(
  block: SubstrateBlock,
  event: EvmLogEvent
): TransferData | null {
  try {
    const { from, to, tokenId } = erc721.events[
      "Transfer(address,address,uint256)"
    ].decode(event.args);
  
    const transfer: TransferData = {
      id: event.id,
      token: tokenId.toString(),
      from,
      to,
      timestamp: BigInt(block.timestamp),
      block: block.height,
      transactionHash: event.evmTxHash,
      contractAddress: event.args.address,
    };
  
    return transfer;
  } catch (error) {
    return null
  }
}

async function saveTransfers(ctx: Context, transfersData: TransferData[]) {
  const tokensIds: Set<string> = new Set();
  const ownersIds: Set<string> = new Set();
  const contractAddresses: Set<string> = new Set();

  for (const transferData of transfersData) {
    tokensIds.add(collectionWithTokenId(transferData.contractAddress, transferData.token));
    ownersIds.add(transferData.from);
    ownersIds.add(transferData.to);
    contractAddresses.add(transferData.contractAddress)
  }

  const transfers: Set<Transfer> = new Set();

  let tokens: Map<string, Token> = new Map(
    (await ctx.store.findBy(Token, { id: In([...tokensIds]) })).map((token) => [
      token.id,
      token,
    ])
  );

  const owners: Map<string, Owner> = new Map(
    (await ctx.store.findBy(Owner, { id: In([...ownersIds]) })).map((owner) => [
      owner.id,
      owner,
    ])
  );

  const collections: Map<string, Contract> = new Map(
    (await ctx.store.findBy(Contract, { id: In([...contractAddresses]) })).map((collection) => [
      collection.id,
      collection,
    ])
  )

  for (const transferData of transfersData) {

    const blockHeight = { height: transferData.block}
    const tokenContract = new erc721.Contract(ctx, blockHeight, transferData.contractAddress)

    let collection = collections.get(transferData.contractAddress)
    if (collection == null) {
      collection = new Contract(
        {
          id: transferData.contractAddress,
        }
      )
      collections.set(collection.id, collection)
    }

    let from = owners.get(transferData.from);
    if (from == null) {
      from = new Owner({ id: transferData.from, balance: 0n });
      owners.set(from.id, from);
    }

    let to = owners.get(transferData.to);
    if (to == null) {
      to = new Owner({ id: transferData.to, balance: 0n });
      owners.set(to.id, to);
    }

    let token = tokens.get(collectionWithTokenId(transferData.contractAddress, transferData.token));
    if (token == null) {
      const uri = await handleURI(ctx, blockHeight.height, transferData.contractAddress, transferData.token)
      token = new Token({
        id: collectionWithTokenId(transferData.contractAddress, transferData.token),
        uri,
        oldUri: uri,
        imageUri: await handleImage(uri, ctx),
        contract: collection,
        tokenId: parseInt(transferData.token),
        owner: to
      });
      tokens.set(token.id, token);
    } else {
      const currentURI = await handleURI(ctx, blockHeight.height, transferData.contractAddress, transferData.token)
      if (token.oldUri !== currentURI) tokens = await handleChangeURI(ctx, token.oldUri ?? "", blockHeight.height, transferData.contractAddress, tokens)

      token = tokens.get(collectionWithTokenId(transferData.contractAddress, transferData.token));
      if (token != null) {
        token.owner = to
        token.uri = currentURI
        token.oldUri = token.uri
        token.imageUri = await handleImage(token.uri, ctx)
        tokens.set(token.id, token)
        ctx.log.info(`${token.id} - ${token.uri} - ${token.imageUri} - ${token.oldUri}`)
      }
    }

    const { id, block, transactionHash, timestamp } = transferData;

    const transfer = new Transfer({
      id,
      block,
      timestamp,
      transactionHash,
      from,
      to,
      token,
    });

    transfers.add(transfer);
  }

  await ctx.store.save([...collections.values()])
  await ctx.store.save([...owners.values()]);
  await ctx.store.save([...tokens.values()]);
  await ctx.store.save([...transfers]);
}
