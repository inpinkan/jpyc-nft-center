// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/*
  JPYCNFT_ERC721_v2.17.0_Polygon_Production_Safety

  ERC721-compatible NFT contract for JPYC NFT Center.

  Production safety updates from v2.16.0:
  - Keeps the frontend-compatible mint(address,string) ABI.
  - Restricts minting to the connected caller's own address.
  - Implements ERC721Receiver checks for both safeTransferFrom overloads.
  - Removes the unused contractOwner / onlyContractOwner path.
  - Preserves Marketplace-compatible approvals and transferFrom behavior.

  Deployment order:
  1. Deploy this NFT contract on Polygon.
  2. Record the Polygon NFT contract address.
  3. Deploy the JPYC ERC20 Marketplace with this NFT address and the verified
     Polygon JPYC token address.
  4. Enter the verified addresses into the frontend production registry.
*/

interface IERC721Receiver {
    function onERC721Received(
        address operator,
        address from,
        uint256 tokenId,
        bytes calldata data
    ) external returns (bytes4);
}

contract JPYCNFT_ERC721 {
    string public name = "JPYC NFT Center";
    string public symbol = "JPYCNFT";

    uint256 public nextTokenId;

    mapping(uint256 => address) private _owners;
    mapping(address => uint256) private _balances;
    mapping(uint256 => string) private _tokenURIs;

    mapping(uint256 => address) private _tokenApprovals;
    mapping(address => mapping(address => bool)) private _operatorApprovals;

    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);
    event Approval(address indexed owner, address indexed approved, uint256 indexed tokenId);
    event ApprovalForAll(address indexed owner, address indexed operator, bool approved);

    function supportsInterface(bytes4 interfaceId) public pure returns (bool) {
        return
            interfaceId == 0x80ac58cd || // ERC721
            interfaceId == 0x5b5e139f || // ERC721Metadata
            interfaceId == 0x01ffc9a7;   // ERC165
    }

    function ownerOf(uint256 tokenId) public view returns (address) {
        address owner = _owners[tokenId];
        require(owner != address(0), "nonexistent token");
        return owner;
    }

    function balanceOf(address owner) public view returns (uint256) {
        require(owner != address(0), "zero address");
        return _balances[owner];
    }

    function tokenURI(uint256 tokenId) public view returns (string memory) {
        require(_exists(tokenId), "nonexistent token");
        return _tokenURIs[tokenId];
    }

    function mint(address to, string memory uri) public returns (uint256) {
        require(to != address(0), "zero address");
        require(to == msg.sender, "mint recipient must be caller");
        require(bytes(uri).length != 0, "empty token URI");

        uint256 tokenId = ++nextTokenId;

        _owners[tokenId] = to;
        _balances[to] += 1;
        _tokenURIs[tokenId] = uri;

        emit Transfer(address(0), to, tokenId);

        return tokenId;
    }

    function approve(address to, uint256 tokenId) public {
        address owner = ownerOf(tokenId);
        require(to != owner, "approval to current owner");
        require(
            msg.sender == owner || isApprovedForAll(owner, msg.sender),
            "not owner nor approved for all"
        );

        _tokenApprovals[tokenId] = to;
        emit Approval(owner, to, tokenId);
    }

    function getApproved(uint256 tokenId) public view returns (address) {
        require(_exists(tokenId), "nonexistent token");
        return _tokenApprovals[tokenId];
    }

    function setApprovalForAll(address operator, bool approved) public {
        require(operator != msg.sender, "approve to caller");

        _operatorApprovals[msg.sender][operator] = approved;
        emit ApprovalForAll(msg.sender, operator, approved);
    }

    function isApprovedForAll(address owner, address operator) public view returns (bool) {
        return _operatorApprovals[owner][operator];
    }

    function transferFrom(address from, address to, uint256 tokenId) public {
        require(_isApprovedOrOwner(msg.sender, tokenId), "not approved nor owner");
        _transfer(from, to, tokenId);
    }

    function safeTransferFrom(address from, address to, uint256 tokenId) public {
        safeTransferFrom(from, to, tokenId, "");
    }

    function safeTransferFrom(
        address from,
        address to,
        uint256 tokenId,
        bytes memory data
    ) public {
        require(_isApprovedOrOwner(msg.sender, tokenId), "not approved nor owner");
        _safeTransfer(from, to, tokenId, data);
    }

    function _exists(uint256 tokenId) internal view returns (bool) {
        return _owners[tokenId] != address(0);
    }

    function _isApprovedOrOwner(address spender, uint256 tokenId) internal view returns (bool) {
        address owner = ownerOf(tokenId);
        return (
            spender == owner ||
            getApproved(tokenId) == spender ||
            isApprovedForAll(owner, spender)
        );
    }

    function _safeTransfer(
        address from,
        address to,
        uint256 tokenId,
        bytes memory data
    ) internal {
        _transfer(from, to, tokenId);
        require(
            _checkOnERC721Received(msg.sender, from, to, tokenId, data),
            "unsafe ERC721 recipient"
        );
    }

    function _transfer(address from, address to, uint256 tokenId) internal {
        require(ownerOf(tokenId) == from, "from is not owner");
        require(to != address(0), "transfer to zero address");

        delete _tokenApprovals[tokenId];

        _balances[from] -= 1;
        _balances[to] += 1;
        _owners[tokenId] = to;

        emit Transfer(from, to, tokenId);
    }

    function _checkOnERC721Received(
        address operator,
        address from,
        address to,
        uint256 tokenId,
        bytes memory data
    ) private returns (bool) {
        if (to.code.length == 0) {
            return true;
        }

        try IERC721Receiver(to).onERC721Received(operator, from, tokenId, data) returns (
            bytes4 retval
        ) {
            return retval == IERC721Receiver.onERC721Received.selector;
        } catch {
            return false;
        }
    }
}
