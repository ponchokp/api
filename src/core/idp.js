import fs from 'fs';
import path from 'path';
import fetch from 'node-fetch';

import { callbackToClient } from '../utils/callback';
import CustomError from '../error/customError';
import errorType from '../error/type';
import logger from '../logger';

import * as tendermint from '../tendermint/ndid';
import * as common from './common';
import * as utils from '../utils';
import * as config from '../config';
import * as db from '../db';
import * as mq from '../mq';
import * as identity from './identity';

import * as externalCryptoService from '../utils/externalCryptoService';

const callbackUrls = {};

const callbackUrlFilesPrefix = path.join(
  __dirname,
  '..',
  '..',
  'idp-callback-url-' + config.nodeId,
);

[
  { key: 'incoming_request_url', fileSuffix: 'incoming_request' },
  { key: 'identity_result_url', fileSuffix: 'identity_result' },
  { key: 'accessor_sign_url', fileSuffix: 'accessor_sign' },
  { key: 'error_url', fileSuffix: 'error' },
].forEach(({ key, fileSuffix }) => {
  try {
    callbackUrls[key] = fs.readFileSync(
      callbackUrlFilesPrefix + '-' + fileSuffix,
      'utf8'
    );
  } catch (error) {
    if (error.code === 'ENOENT') {
      logger.warn({
        message: `${fileSuffix} callback url file not found`,
      });
    } else {
      logger.error({
        message: `Cannot read ${fileSuffix} callback url file`,
        error,
      });
    }
  }
});

function writeCallbackUrlToFile(fileSuffix, url) {
  fs.writeFile(callbackUrlFilesPrefix + '-' + fileSuffix, url, (err) => {
    if (err) {
      logger.error({
        message: `Cannot write ${fileSuffix} callback url file`,
        error: err,
      });
    }
  });
}

export function setCallbackUrls({
  incoming_request_url,
  identity_result_url,
  accessor_sign_url,
  error_url,
}) {
  if (incoming_request_url != null) {
    callbackUrls.incoming_request_url = incoming_request_url;
    writeCallbackUrlToFile('incoming_request', incoming_request_url);
  }
  if (identity_result_url != null) {
    callbackUrls.identity_result_url = identity_result_url;
    writeCallbackUrlToFile('identity_result', identity_result_url);
  }
  if (accessor_sign_url != null) {
    callbackUrls.accessor_sign_url = accessor_sign_url;
    writeCallbackUrlToFile('accessor_sign', accessor_sign_url);
  }
  if (error_url != null) {
    callbackUrls.error_url = error_url;
    writeCallbackUrlToFile('error', error_url);
  }
}

export function getCallbackUrls() {
  return callbackUrls;
}

export function isAccessorSignUrlSet() {
  return callbackUrls.accessor_sign_url != null;
}

export async function accessorSign(sid ,hash_id, accessor_id) {
  const data = {
    sid_hash: hash_id,
    sid,
    hash_method: 'SHA256',
    key_type: 'RSA',
    sign_method: 'RSA',
    accessor_id
  };

  if (callbackUrls.accessor_sign_url == null) {
    throw new CustomError({
      message: errorType.SIGN_WITH_ACCESSOR_KEY_URL_NOT_SET.message,
      code: errorType.SIGN_WITH_ACCESSOR_KEY_URL_NOT_SET.code,
    });
  }

  logger.debug({
    message: 'Callback to accessor sign',
    url: callbackUrls.accessor_sign_url,
    accessor_id,
    hash_id,
  });

  try {
    const response = await fetch(callbackUrls.accessor_sign_url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(data),
    });
    const signatureObj = await response.json();
    return signatureObj.signature;
  } catch (error) {
    throw new CustomError({
      message: errorType.SIGN_WITH_ACCESSOR_KEY_FAILED.message,
      code: errorType.SIGN_WITH_ACCESSOR_KEY_FAILED.code,
      cause: error,
      details: {
        callbackUrl: callbackUrls.accessor_sign_url,
        accessor_id,
        hash_id,
      }
    })
  }
}

export async function createIdpResponse(data) {
  try {
    let {
      request_id,
      //namespace,
      //identifier,
      aal,
      ial,
      status,
      signature,
      accessor_id,
      secret,
      request_message,
    } = data;

    const request = await common.getRequest({ requestId: request_id });
    if (request == null) {
      throw new CustomError({
        message: errorType.REQUEST_NOT_FOUND.message,
        code: errorType.REQUEST_NOT_FOUND.code,
        clientError: true,
        details: {
          request_id,
        },
      });
    }

    const accessorPublicKey = await common.getAccessorKey(accessor_id);
    if (accessorPublicKey == null) {
      throw new CustomError({
        message: errorType.ACCESSOR_PUBLIC_KEY_NOT_FOUND.message,
        code: errorType.ACCESSOR_PUBLIC_KEY_NOT_FOUND.code,
        clientError: true,
        details: {
          accessor_id,
        },
      });
    }

    //TODO
    //query mode from requestId
    let requestStatus = await common.getRequest({ requestId: request_id });
    let mode = requestStatus.mode;
    let dataToBlockchain, privateProofObject;

    if(mode === 3) {
      let { blockchainProof, privateProofValue, padding } = utils.generateIdentityProof({
        publicKey: await common.getAccessorKey(accessor_id),
        challenge: (await db.getRequestReceivedFromMQ(request_id)).challenge,
        secret,
      });
    
      privateProofObject = {
        privateProofValue,
        accessor_id,
        padding,
      };

      dataToBlockchain = {
        request_id,
        aal,
        ial,
        status,
        signature,
        //accessor_id,
        identity_proof: blockchainProof,
        private_proof_hash: utils.hash(privateProofValue),
      };
    }
    else {
      signature = await utils.createSignature(request_message);
      dataToBlockchain = {
        request_id,
        aal,
        ial,
        status,
        signature,
      };
    }

    await db.removeRequestReceivedFromMQ(request_id);

    let { height } = await tendermint.transact(
      'CreateIdpResponse',
      dataToBlockchain,
      utils.getNonce()
    );

    sendPrivateProofToRP(request_id, privateProofObject, height);
  } catch (error) {
    const err = new CustomError({
      message: 'Cannot create IdP response',
      cause: error,
    });
    logger.error(err.getInfoForLog());
    throw err;
  }
}

export function notifyByCallback(eventDataForCallback) {
  if (!callbackUrls.incoming_request_url) {
    logger.error({
      message: 'Callback URL for IdP has not been set',
    });
    return;
  }
  return callbackToClient(callbackUrls.incoming_request_url, eventDataForCallback, true);
}

async function sendPrivateProofToRP(request_id, privateProofObject, height) {
  let rp_id = await db.getRPIdFromRequestId(request_id);

  logger.info({
    message: 'Query MQ destination for RP',
  });
  logger.debug({
    message: 'Query MQ destination for RP',
    rp_id,
  });

  let { ip, port } = await common.getMsqAddress(rp_id);
  let rpMq = {
    ip,
    port,
    ...(await common.getNodePubKey(rp_id)),
  };

  mq.send([rpMq], {
    request_id,
    ...privateProofObject,
    height,
    idp_id: config.nodeId,
  });

  db.removeRPIdFromRequestId(request_id);
}

export async function handleMessageFromQueue(messageStr) {
  logger.info({
    message: 'Received message from MQ',
  });
  logger.debug({
    message: 'Message from MQ',
    messageStr,
  });
  const message = JSON.parse(messageStr);
  //need challenge for response
  await db.setRequestReceivedFromMQ(message.request_id, message);

  const latestBlockHeight = tendermint.latestBlockHeight;
  if (latestBlockHeight <= message.height) {
    logger.debug({
      message: 'Saving message from MQ',
      tendermintLatestBlockHeight: latestBlockHeight,
      messageBlockHeight: message.height,
    });
    await db.addRequestIdExpectedInBlock(
      message.height,
      message.request_id
    );
    await db.setRPIdFromRequestId(message.request_id, message.rp_id);

    if(message.accessor_id) {
      //====================== COPY-PASTE from RP, need refactoring =====================
      //store private parameter from EACH idp to request, to pass along to as
      let request = await db.getRequestData(message.request_id);
      //AS involve
      if (request) {
        if (request.privateProofObjectList) {
          request.privateProofObjectList.push({
            idp_id: message.idp_id,
            privateProofObject: {
              privateProofValue: message.privateProofValue,
              accessor_id: message.accessor_id,
              padding: message.padding,
            },
          });
        } else {
          request.privateProofObjectList = [
            {
              idp_id: message.idp_id,
              privateProofObject: {
                privateProofValue: message.privateProofValue,
                accessor_id: message.accessor_id,
                padding: message.padding,
              },
            },
          ];
        }
        await db.setRequestData(message.request_id, request);
      }
      //====================================================================================
    }
    return;
  }

  logger.debug({
    message: 'Processing request',
    requestId: message.request_id,
  });
  //onboard response
  if(message.accessor_id) {
    if(await checkOnboardResponse(message)) {
      let secret = await identity.addAccessorAfterConsent(message.request_id, message.accessor_id);
      notifyByCallback({
        type: 'onboard_consent_request',
        request_id: message.request_id,
        success: true,
        secret,
      });
    }
  }
  else {
    const valid = await common.checkRequestIntegrity(
      message.request_id,
      message
    );
    if (valid) {
      notifyByCallback({
        type: 'consent_request',
        request_id: message.request_id,
        namespace: message.namespace,
        identifier: message.identifier,
        request_message: message.request_message,
        request_message_hash: utils.hash(message.request_message),
        requester_node_id: message.rp_id,
        min_ial: message.min_ial,
        min_aal: message.min_aal,
        data_request_list: message.data_request_list,
      });
    }
  }
}

export async function handleTendermintNewBlockHeaderEvent(
  error,
  result,
  missingBlockCount
) {
  const height = tendermint.getBlockHeightFromNewBlockHeaderEvent(result);

  // messages that arrived before 'NewBlock' event
  // including messages between the start of missing block's height
  // and the block before latest block height
  // (not only just (current height - 1) in case 'NewBlock' events are missing)
  // NOTE: tendermint always create a pair of block. A block with transactions and
  // a block that signs the previous block which indicates that the previous block is valid
  const fromHeight =
    missingBlockCount == null
      ? 1
      : missingBlockCount === 0
        ? height - 1
        : height - missingBlockCount;
  const toHeight = height - 1;

  logger.debug({
    message: 'Getting request IDs to process',
    fromHeight,
    toHeight,
  });

  const requestIdsInTendermintBlock = await db.getRequestIdsExpectedInBlock(
    fromHeight,
    toHeight
  );
  await Promise.all(
    requestIdsInTendermintBlock.map(async (requestId) => {
      logger.debug({
        message: 'Processing request',
        requestId,
      });
      const message = await db.getRequestReceivedFromMQ(requestId);
      //reposne for onboard
      if(message.accessor_id) {
        if(await checkOnboardResponse(message)) {
          let secret = await identity.addAccessorAfterConsent(message.request_id, message.accessor_id);
          notifyByCallback({
            type: 'onboard_consent_request',
            request_id: message.request_id,
            success: true,
            secret,
          });
        }
      }
      else {
        const valid = await common.checkRequestIntegrity(requestId, message);
        if (valid) {
          notifyByCallback({
            type: 'consent_request',
            request_id: message.request_id,
            namespace: message.namespace,
            identifier: message.identifier,
            request_message: message.request_message,
            request_message_hash: utils.hash(message.request_message),
            requester_node_id: message.rp_id,
            min_ial: message.min_ial,
            min_aal: message.min_aal,
            data_request_list: message.data_request_list,
          });
        }
      }
    })
  );

  db.removeRequestIdsExpectedInBlock(fromHeight, toHeight);
}

//===================== Initialize before flow can start =======================

export async function init() {
  // FIXME: In production this should be done only once. Hence, init() is not needed.

  // Wait for blockchain ready
  await tendermint.ready;

  if (config.useExternalCryptoService) {
    for (;;) {
      if (externalCryptoService.isCallbackUrlsSet()) {
        break;
      }
      await utils.wait(5000);
    }
  }

  common.registerMsqAddress(config.mqRegister);
}

async function checkOnboardResponse(message) {
  let reason = false;
  let requestDetail = await common.getRequestDetail({
    requestId: message.request_id
  });
  let response = requestDetail.response_list[0];
  
  if(!(await common.verifyZKProof(message.request_id, message.idp_id, message))) {
    reason = 'Invalid response';
  }
  else if(response.status !== 'accept') {
    reason = 'User rejected';
  }

  if(reason) {
    notifyByCallback({
      type: 'onboard_consent_request',
      request_id: message.request_id,
      success: false,
      reason: reason
    });

    logger.debug({
      message: 'Onboarding failed',
      reason,
    });

    db.removeChallengeFromRequestId(message.request_id);
    return false;
  }
  logger.debug({
    message: 'Onboard consented',
  });
  db.removeChallengeFromRequestId(message.request_id);
  return true;
}