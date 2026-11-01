// Fill only after deployment, runtime verification and origin migration review.
// ready controls the public trading UI; contract newPositionsEnabled is independent.
window.JNC_DEPLOYMENTS = {
  polygon: {
    newMarketplace: '0x7F4752Bf3dA61842F1729C7552187F785e2f20E2', runtimeCodeHash: '0x0e630d2f51776b526e3e69657691f325e4d25eba26e2daf06b3b28a0ceb93a0e', ready: false,
    feeWallet: '0x7f60cbDb0CCdbf65E9a67dBbE53ea06910bCaeB5',
    legacyMarketplaces: ['0xaB6659Ae04a556Dd848A0B16e6037928Ea2124B1', '0x7120910884379E0C6c5AADcc56c888436ef5eB81']
  },
  bnb: {
    newMarketplace: '0xB85ceC4f53Fe09ec14F31bd8e6674231cB0f5C6D', runtimeCodeHash: '0xc47b7bc630da9b8204976a8a2d06460cef9079af25e8971dd25663a42b270a4e', ready: false,
    feeWallet: '0x7f60cbDb0CCdbf65E9a67dBbE53ea06910bCaeB5',
    legacyMarketplaces: ['0xab83444A0f35D5388Fa2B6161aC177aA4Aabb1Eb', '0xAdAcd3ceef3629f4031E9d4F189Fbd198691f044']
  }
};
