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
import { FindOperator, In, IsNull } from "typeorm";
import {
  CHAIN_NODE, contractMapping
} from "./contract";
import { getWhitelistNFT } from "./helper/whitelistnftlist"
import { Owner, Token, Transfer, Contract } from "./model";
import * as erc721 from "./abi/erc721";
import { ethers } from "ethers";
import axios from "axios"
import { CID } from "multiformats/cid"

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
        const event = item.event;
        let evmLog = event.args.log || event.args; 
        const topics: string[] = evmLog.topics
        if (topics[0] === erc721.events["Transfer(address,address,uint256)"].topic) {
          const transfer = handleTransfer(block.header, item.event);
          if (transfer) transfersData.push(transfer);
        }
      }
    }
  }

  await saveTransfers(ctx, transfersData);
  await handleNullImage(ctx)
  ctx.log.info("Round Finish")
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

function handleTransfer(
  block: SubstrateBlock,
  event: EvmLogEvent
): TransferData | null {
  try {
    const log = event.args.log || event.args
    const { from, to, tokenId } = erc721.events[
      "Transfer(address,address,uint256)"
    ].decode(log);
    const transfer: TransferData = {
      id: event.id,
      token: tokenId.toString(),
      from,
      to,
      timestamp: BigInt(block.timestamp),
      block: block.height,
      transactionHash: event.evmTxHash,
      contractAddress: log.address,
    };
  
    return transfer;
  } catch (error) {
    return null
  }
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
  return `${contractMapping.get(collection)?.symbol || collection}-${tokenId}`
}

function handleIpfsUri (uri: string, ctx: Context) {
  try {
    const splits = uri.split("/");

    const possibleCid = splits.reduce(
      function (a, b) {
          return a.length > b.length ? a : b;
      }
    );

    const cid = CID.asCID(CID.parse(possibleCid))
    
    if (cid) {
      // astarDegens
      if (uri.includes("ipfs://")) {
        const constructURI = `https://${cid.toV1()}.ipfs.nftstorage.link/${splits[splits.length -1]}`
        return constructURI
      }
      // astarCats
      if (uri.includes("https://arweave.net")) {
        return uri
      }
      // astarSignWitch
      if (uri.includes("gateway.pinata.cloud")) {
        const constructURI = `https://${cid.toV1()}.ipfs.nftstorage.link/${splits[splits.length -1]}`
        return constructURI
      }
    }
    
    return uri
  } catch (error) {
    return uri
  }
}

async function handleImage(tokenURI: string, ctx: Context) {
  try {
    // check if the URI is centralized of decentralizer
    // if its decentralized
    if (tokenURI.length === 0) return null
    try {
      const { data } = await axios.get<MetaData>(handleIpfsUri(tokenURI, ctx))
      if (data?.image) return data.image
      if (data?.image_alt) return data.image_alt
      ctx.log.error(`Data does not exist: ${data} ${handleIpfsUri(tokenURI, ctx)}`)
      return null
    } catch (error) {
      ctx.log.error(`Fetching Image Error: ${handleIpfsUri(tokenURI, ctx)} - ${error}`)
      return null
    }
  } catch (error: any) {
    ctx.log.error(`error handleImage: ${error}`)
    return null
  }
}

async function handleNullImage (ctx: Context) {
  let tokens: Map<string, Token> = new Map(
    (await ctx.store.find(Token, { where: { imageUri : IsNull() } })).map((token) => [
      token.id,
      token,
    ])
  );

  for (const token of tokens) {
    const _token = token[1]
    if (_token.uri) {
      _token.imageUri = await handleImage(_token.uri, ctx)
      tokens.set(_token.id, _token)
    }
  }

  if ([...tokens.values()].length > 0) {
    await ctx.store.save([...tokens.values()])
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
    // hardcode the block height to recent block until know how to get the highest block
    const hardCodedBlockHeight = 1789333;
    const tokenContract = new erc721.Contract(ctx, { height: hardCodedBlockHeight > height ? hardCodedBlockHeight : height }, contractAddress)
    return await tokenContract.tokenURI(ethers.BigNumber.from(tokenId)) 
  } catch (error: any) {
    ctx.log.error(`Error handling URI : ${error}`)
    return ""
  }
}

function handleBalance (ownersMap: Map<string, Owner> ,owner: Owner, address: string, mode: number) {
  let _owner = ownersMap.get(owner.id)
  if (_owner == null) return ownersMap
  switch (address) {
    case "0x8b5d62f396ca3c6cf19803234685e693733f9779":
      if (_owner.astarCatsBalance == null) {
        _owner.astarCatsBalance = 1;
        ownersMap.set(_owner.id, _owner)
        return ownersMap
      } else {
        if (mode === 0) {
          _owner.astarCatsBalance = _owner.astarCatsBalance + 1;
          ownersMap.set(_owner.id, _owner)
          return ownersMap
        } else if (mode === 1) {
          _owner.astarCatsBalance = _owner.astarCatsBalance - 1; 
          ownersMap.set(_owner.id, _owner)
          return ownersMap
        } else {
          return ownersMap
        }
      }
      break;
    case "0xd59fc6bfd9732ab19b03664a45dc29b8421bda9a":
      if (_owner.astarDegensBalance == null) {
        _owner.astarDegensBalance = 1;
        
        ownersMap.set(_owner.id, _owner)
        return ownersMap
      } else {
        if (mode === 0) {
          _owner.astarDegensBalance = _owner.astarDegensBalance + 1;
          ownersMap.set(_owner.id, _owner)
          return ownersMap
        } else if (mode === 1) {
          _owner.astarDegensBalance = _owner.astarDegensBalance - 1;
          ownersMap.set(_owner.id, _owner)
          return ownersMap
        } else {
          return ownersMap
        }
      }
      break;
    case "0x7b2152e51130439374672af463b735a59a47ea85":
      if (_owner.astarSignWitchBalance == null) {
        _owner.astarSignWitchBalance = 1;
        ownersMap.set(_owner.id, _owner)
        return ownersMap
      } else {
        if (mode === 0) {
          _owner.astarSignWitchBalance = _owner.astarSignWitchBalance + 1;
          ownersMap.set(_owner.id, _owner)
          return ownersMap
        } else if (mode === 1) {
          _owner.astarSignWitchBalance = _owner.astarSignWitchBalance - 1;
          ownersMap.set(_owner.id, _owner)
          return ownersMap
        } else {
          return ownersMap
        }
      }
      break;
    case "0x05a1ed91d2760b751cbe68dd2c644f182069782c":
      if (_owner.astarB2EBalance == null) {
        _owner.astarB2EBalance = 1;
        ownersMap.set(_owner.id, _owner)
        return ownersMap
      } else {
        if (mode === 0) {
          _owner.astarB2EBalance = _owner.astarB2EBalance + 1;
          ownersMap.set(_owner.id, _owner)
          return ownersMap
        } else if (mode === 1) {
          _owner.astarB2EBalance = _owner.astarB2EBalance - 1;
          ownersMap.set(_owner.id, _owner)
          return ownersMap
        } else {
          return ownersMap
        }
      }
      break;
    default:
      ownersMap.set(_owner.id, _owner)
      return ownersMap
      break;
  }
}

async function handleContractName(ctx: Context, height: number, contractAddress: string) {
  try {
    const hardCodedBlockHeight = 1789333;
    const tokenContract = new erc721.Contract(ctx, { height: hardCodedBlockHeight > height ? hardCodedBlockHeight : height }, contractAddress);
    return await tokenContract.name();
  } catch (error) {
    return null
  }
}

async function handleContractSymbol(ctx: Context, height: number, contractAddress: string) {
  try {
    const hardCodedBlockHeight = 1789333;
    const tokenContract = new erc721.Contract(ctx, { height: hardCodedBlockHeight > height ? hardCodedBlockHeight : height }, contractAddress);
    return await tokenContract.symbol();
  } catch (error) {
    return null
  }
}

async function handleContractTotalSupply(ctx: Context, height: number, contractAddress: string) {
  try {
    const hardCodedBlockHeight = 1789333;
    const tokenContract = new erc721.Contract(ctx, { height: hardCodedBlockHeight > height ? hardCodedBlockHeight : height }, contractAddress);
    return await tokenContract.totalSupply();
  } catch (error) {
    return null
  }
}

async function handleContract(ctx: Context, height: number, contractAddress: string) {
  const cacheContract = contractMapping.get(contractAddress)
  if (cacheContract) return cacheContract
  const totalSupply = await handleContractTotalSupply(ctx, height, contractAddress)
  const typeFriendlyTotalSupply = totalSupply ? totalSupply.toBigInt() : ethers.BigNumber.from("0").toBigInt();
  const contractObject = new Contract({
    id: contractAddress,
    name: await handleContractName(ctx, height, contractAddress),
    symbol: await handleContractSymbol(ctx, height, contractAddress),
    totalSupply: typeFriendlyTotalSupply
  })
  contractMapping.set(contractAddress, contractObject)
  return contractObject
}

async function saveTransfers(ctx: Context, transfersData: TransferData[]) {
  const tokensIds: Set<string> = new Set();
  const ownersIds: Set<string> = new Set();
  const contractAddresses: Set<string> = new Set();

  for (const transferData of transfersData) {
    await handleContract(ctx, transferData.block, transferData.contractAddress)
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

  let owners: Map<string, Owner> = new Map(
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

    let collection = collections.get(transferData.contractAddress)
    if (collection == null) {
      collection = await handleContract(ctx, transferData.block, transferData.contractAddress)
      collections.set(collection.id, collection)
      console.log(collection.id, collection.name, collection.symbol, collection.totalSupply)
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
      
      owners = handleBalance(owners ,to, transferData.contractAddress, 0)
      to = owners.get(transferData.to);

      token = new Token({
        id: collectionWithTokenId(transferData.contractAddress, transferData.token),
        uri,
        oldUri: uri,
        imageUri: await handleImage(uri, ctx),
        contract: collection,
        tokenId: parseInt(transferData.token),
        owner: to //waiting for fix from squid-devs
      });
      tokens.set(token.id, token);
    } else {
      owners = handleBalance(owners, to, transferData.contractAddress, 0)
      owners = handleBalance(owners, from, transferData.contractAddress, 1)
      to = owners.get(transferData.to);
      from = owners.get(transferData.from);
 
      token.owner = to
      token.contract = collection //waiting for fix from squid-devs
      tokens.set(token.id, token);
    }

    ctx.log.warn(`${token.id} - ${token.uri} - ${token.imageUri} - ${token.oldUri} - ${token.contract} ${collection.id}`)

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
