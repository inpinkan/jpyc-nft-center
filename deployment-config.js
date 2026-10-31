// Fill only after deployment, runtime verification and origin migration review.
// ready controls the public trading UI; contract newPositionsEnabled is independent.
window.JNC_DEPLOYMENTS = {
  polygon: {
    newMarketplace: '', runtimeCodeHash: '', ready: false,
    feeWallet: '0x7f60cbDb0CCdbf65E9a67dBbE53ea06910bCaeB5',
    legacyMarketplaces: ['0xaB6659Ae04a556Dd848A0B16e6037928Ea2124B1', '0x7120910884379E0C6c5AADcc56c888436ef5eB81']
  },
  bnb: {
    newMarketplace: '', runtimeCodeHash: '', ready: false,
    feeWallet: '0x7f60cbDb0CCdbf65E9a67dBbE53ea06910bCaeB5',
    legacyMarketplaces: ['0xab83444A0f35D5388Fa2B6161aC177aA4Aabb1Eb', '0xAdAcd3ceef3629f4031E9d4F189Fbd198691f044']
  }
};
