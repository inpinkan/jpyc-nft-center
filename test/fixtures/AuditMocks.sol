// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// Local audit fixtures only. Never deploy to a public chain.
contract AuditToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    mapping(address => bool) public blocked;
    bool public taxed;
    function mint(address to, uint256 amount) external { balanceOf[to] += amount; }
    function setBlocked(address who, bool value) external { blocked[who] = value; }
    function setTaxed(bool value) external { taxed = value; }
    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount; return true;
    }
    function transfer(address to, uint256 amount) external returns (bool) {
        _move(msg.sender, to, amount); return true;
    }
    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        require(allowance[from][msg.sender] >= amount, "allowance");
        allowance[from][msg.sender] -= amount;
        _move(from, to, amount); return true;
    }
    function _move(address from, address to, uint256 amount) internal {
        require(!blocked[from] && !blocked[to], "blocked");
        require(balanceOf[from] >= amount, "balance");
        balanceOf[from] -= amount;
        balanceOf[to] += taxed ? amount - amount / 10 : amount;
    }
}

interface IAuditToken { function approve(address, uint256) external returns (bool); }
interface IAuditMarket {
    function bid(uint256, uint256) external;
    function buy(uint256) external;
    function claimAuctionNFT(uint256, address) external;
}

contract AuditBidder {
    bool public rejecting = true;
    bool public reenter;
    bool public callbackBlocked;
    address public market;
    uint256 public listing;
    function approve(address token, address spender) external {
        IAuditToken(token).approve(spender, type(uint256).max);
    }
    function placeBid(address target, uint256 id, uint256 amount) external {
        IAuditMarket(target).bid(id, amount);
    }
    function setRejecting(bool value) external { rejecting = value; }
    function claim(address target, uint256 id, address recipient) external {
        IAuditMarket(target).claimAuctionNFT(id, recipient);
    }
    function buyWithReentry(address target, uint256 id) external {
        market = target; listing = id; reenter = true;
        IAuditMarket(target).buy(id);
    }
    function onERC721Received(address, address, uint256, bytes calldata) external returns (bytes4) {
        require(!rejecting, "reject NFT");
        if (reenter) {
            (bool success,) = market.call(abi.encodeWithSignature("buy(uint256)", listing));
            callbackBlocked = !success;
        }
        return 0x150b7a02;
    }
}

contract LegacyOriginMock {
    mapping(address => mapping(uint256 => bool)) public originRegistered;
    mapping(address => mapping(uint256 => address)) public originalCreator;
    mapping(address => mapping(uint256 => bool)) public primarySaleCompleted;
    function setOrigin(address nft, uint256 id, address creator, bool completed) external {
        originRegistered[nft][id] = true;
        originalCreator[nft][id] = creator;
        primarySaleCompleted[nft][id] = completed;
    }
}
