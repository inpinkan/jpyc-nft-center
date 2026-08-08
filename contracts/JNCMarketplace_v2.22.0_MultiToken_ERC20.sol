// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/*
    JNCMarketplace_v2.22.0_MultiToken_ERC20

    JPYC NFT Center multi-token ERC20 marketplace.

    Design rules:
    - All sale, offer, bid, refund, fee and royalty amounts are ERC20 base units.
    - Native-token payment paths do not exist in this contract.
    - Payment tokens are registered by the fee wallet.
    - New listings, offers and auctions require an enabled payment token.
    - Disabling a payment token blocks new market positions only.
    - Existing listings, offers, auctions, bids, settlements and refunds continue
      with the payment token stored in each market position.
    - Each ERC20 payment token has an immutable absolute floor and an operator minimum.
    - The operator minimum can be raised or lowered, but never below the absolute floor.
    - Auction bid increment is snapshotted when the auction is created.
    - Primary sale: seller 95%, marketplace 5% by default.
    - Resale: seller 85%, creator 10%, marketplace 5% by default.
*/

interface IERC721JNC {
    function ownerOf(uint256 tokenId) external view returns (address);
    function getApproved(uint256 tokenId) external view returns (address);
    function isApprovedForAll(address owner, address operator) external view returns (bool);
    function safeTransferFrom(address from, address to, uint256 tokenId) external;
}

interface IERC20JNC {
    function balanceOf(address account) external view returns (uint256);
    function allowance(address owner, address spender) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

contract JNCMarketplace {
    struct PaymentTokenConfig {
        bool configured;
        bool enabled;
        uint256 floorPaymentAmount;
        uint256 minimumPaymentAmount;
    }

    struct Listing {
        address nftContract;
        uint256 tokenId;
        address seller;
        address paymentToken;
        uint256 price;
        bool active;
    }

    struct Offer {
        address nftContract;
        uint256 tokenId;
        address buyer;
        address paymentToken;
        uint256 amount;
        uint64 expiresAt;
        bool active;
    }

    struct Auction {
        address nftContract;
        uint256 tokenId;
        address seller;
        address paymentToken;
        uint256 reservePrice;
        uint256 buyNowPrice;
        uint256 highestBid;
        uint256 minimumBidIncrement;
        address highestBidder;
        uint64 startAt;
        uint64 endsAt;
        uint32 durationDays;
        bool active;
    }

    struct Sale {
        address nft;
        uint256 tokenId;
        address seller;
        address buyer;
        address creator;
        address paymentToken;
        uint256 price;
        bool resale;
    }

    error Unauthorized();
    error InvalidInput();
    error InvalidState();
    error NotOwner();
    error NotApproved();
    error BelowMinimum();
    error InsufficientBalance();
    error InsufficientAllowance();
    error TransferFailed();
    error UnsupportedPaymentToken();
    error PaymentTokenNotConfigured();
    error PaymentTokenAlreadyConfigured();
    error PaymentTokenDisabled();
    error Reentrant();

    address public feeWallet;
    uint16 public feeBps;
    uint16 public royaltyBps;

    uint256 public nextListingId;
    uint256 public nextOfferId;
    uint256 public nextAuctionId;

    mapping(address => PaymentTokenConfig) public paymentTokenConfigs;

    mapping(uint256 => Listing) public listings;
    mapping(address => mapping(uint256 => uint256)) public listingIdByNFT;

    mapping(uint256 => Offer) public offers;
    mapping(address => mapping(uint256 => uint256[])) private _offerIds;
    mapping(uint256 => uint256) private _offerPos;

    mapping(uint256 => Auction) private _auctions;
    mapping(address => mapping(uint256 => uint256)) public auctionIdByNFT;

    // paymentToken => bidder => refundable amount
    mapping(address => mapping(address => uint256)) public pendingBidRefunds;

    mapping(address => mapping(uint256 => address)) public originalCreator;
    mapping(address => mapping(uint256 => bool)) public primarySaleCompleted;
    mapping(address => mapping(uint256 => bool)) public originRegistered;

    uint64 public constant ANTI_SNIPING_WINDOW = 5 minutes;
    uint64 public constant ANTI_SNIPING_EXTENSION = 10 minutes;

    uint256 private _lock = 1;

    event NFTOriginRegistered(
        address indexed nftContract,
        uint256 indexed tokenId,
        address indexed creator,
        bool primarySaleAlreadyCompleted
    );

    event PaymentTokenConfigured(
        address indexed paymentToken,
        uint256 floorPaymentAmount,
        uint256 minimumPaymentAmount,
        bool enabled
    );

    event ListingCreated(
        uint256 indexed listingId,
        address indexed nftContract,
        uint256 indexed tokenId,
        address seller,
        address paymentToken,
        uint256 price
    );

    event ListingCancelled(
        uint256 indexed listingId,
        address indexed nftContract,
        uint256 indexed tokenId
    );

    event OfferCreated(
        uint256 indexed offerId,
        address indexed nftContract,
        uint256 indexed tokenId,
        address buyer,
        address paymentToken,
        uint256 amount,
        uint64 expiresAt
    );

    event OfferCancelled(
        uint256 indexed offerId,
        address indexed nftContract,
        uint256 indexed tokenId,
        address buyer,
        address paymentToken,
        uint256 amount
    );

    event AuctionCreated(
        uint256 indexed auctionId,
        address indexed nftContract,
        uint256 indexed tokenId,
        address seller,
        address paymentToken
    );

    event AuctionTerms(
        uint256 indexed auctionId,
        uint256 reservePrice,
        uint256 buyNowPrice,
        uint256 minimumBidIncrement,
        uint64 startAt,
        uint64 endsAt,
        uint32 durationDays
    );

    event AuctionBuyNowCompleted(
        uint256 indexed auctionId,
        address indexed buyer,
        address indexed paymentToken,
        uint256 price
    );

    event AuctionBidPlaced(
        uint256 indexed auctionId,
        address indexed bidder,
        address indexed paymentToken,
        uint256 amount
    );

    event AuctionExtended(
        uint256 indexed auctionId,
        uint64 previousEndsAt,
        uint64 newEndsAt
    );

    event AuctionCancelled(
        uint256 indexed auctionId,
        address indexed nftContract,
        uint256 indexed tokenId
    );

    event SaleCompleted(
        uint8 indexed saleType,
        uint256 indexed referenceId,
        address indexed nftContract,
        uint256 tokenId,
        address seller,
        address buyer,
        address paymentToken,
        uint256 price,
        bool resale
    );

    event BidRefundWithdrawn(
        address indexed bidder,
        address indexed paymentToken,
        uint256 amount
    );

    event ConfigUpdated(
        uint8 indexed field,
        address addressValue,
        uint256 numericValue
    );

    modifier onlyFeeWallet() {
        if (msg.sender != feeWallet) revert Unauthorized();
        _;
    }

    modifier nonReentrant() {
        if (_lock != 1) revert Reentrant();
        _lock = 2;
        _;
        _lock = 1;
    }

    /*
        The initial token is registered here only as the first supported ERC20.
        It is NOT immutable and it is NOT the only token this marketplace can use.

        This keeps deployment close to v2.21.0:
        1. initialPaymentToken
        2. initialFeeWallet
        3. initialFeeBps
        4. initialRoyaltyBps
        5. initialFloorPaymentAmount

        At deployment, the operator minimum starts equal to the immutable floor.
        The operator minimum can later be raised with updatePaymentTokenMinimum().
    */
    constructor(
        address initialPaymentToken,
        address initialFeeWallet,
        uint16 initialFeeBps,
        uint16 initialRoyaltyBps,
        uint256 initialFloorPaymentAmount
    ) {
        if (
            initialPaymentToken == address(0) ||
            initialPaymentToken.code.length == 0 ||
            initialFeeWallet == address(0) ||
            initialFloorPaymentAmount == 0
        ) revert InvalidInput();

        _checkRates(initialFeeBps, initialRoyaltyBps);

        feeWallet = initialFeeWallet;
        feeBps = initialFeeBps;
        royaltyBps = initialRoyaltyBps;

        paymentTokenConfigs[initialPaymentToken] = PaymentTokenConfig({
            configured: true,
            enabled: true,
            floorPaymentAmount: initialFloorPaymentAmount,
            minimumPaymentAmount: initialFloorPaymentAmount
        });

        emit PaymentTokenConfigured(
            initialPaymentToken,
            initialFloorPaymentAmount,
            initialFloorPaymentAmount,
            true
        );
    }

    // ---------------------------------------------------------------------
    // NFT origin
    // ---------------------------------------------------------------------

    function registerNFTOrigin(
        address nft,
        uint256 tokenId,
        address creator,
        bool completed
    ) external onlyFeeWallet {
        _register(nft, tokenId, creator, completed);
    }

    function registerNFTOriginByOwner(address nft, uint256 tokenId) external {
        if (nft == address(0)) revert InvalidInput();
        if (IERC721JNC(nft).ownerOf(tokenId) != msg.sender) revert NotOwner();
        _register(nft, tokenId, msg.sender, false);
    }

    // ---------------------------------------------------------------------
    // Listing
    // ---------------------------------------------------------------------

    function createListing(
        address nft,
        uint256 tokenId,
        uint256 price,
        address paymentToken
    ) external returns (uint256 id) {
        _checkNewPositionPrice(paymentToken, price);
        if (_auctionActive(nft, tokenId)) revert InvalidState();

        IERC721JNC token = IERC721JNC(nft);
        _requireOwnerApproved(token, tokenId, msg.sender);
        _registerIfNeeded(nft, tokenId, msg.sender);
        _cancelListingByNFT(nft, tokenId);

        id = ++nextListingId;
        listings[id] = Listing(
            nft,
            tokenId,
            msg.sender,
            paymentToken,
            price,
            true
        );
        listingIdByNFT[nft][tokenId] = id;

        emit ListingCreated(
            id,
            nft,
            tokenId,
            msg.sender,
            paymentToken,
            price
        );
    }

    function cancelListing(uint256 id) external {
        Listing storage listing = listings[id];
        if (!listing.active || listing.seller != msg.sender) revert Unauthorized();
        _cancelListing(id, listing);
    }

    function buy(uint256 id) external nonReentrant {
        Listing storage listing = listings[id];
        if (
            !listing.active ||
            _auctionActive(listing.nftContract, listing.tokenId)
        ) revert InvalidState();
        if (msg.sender == listing.seller) revert Unauthorized();

        IERC721JNC token = IERC721JNC(listing.nftContract);
        _requireOwnerApproved(token, listing.tokenId, listing.seller);

        Sale memory sale = _sale(
            listing.nftContract,
            listing.tokenId,
            listing.seller,
            msg.sender,
            listing.paymentToken,
            listing.price
        );

        _pullPayment(listing.paymentToken, msg.sender, listing.price);
        _clearListing(listing);
        _settle(sale, listing.seller, 0, id);
    }

    // ---------------------------------------------------------------------
    // Offer
    // ---------------------------------------------------------------------

    function createOffer(
        address nft,
        uint256 tokenId,
        uint256 amount,
        uint64 expiresAt,
        address paymentToken
    ) external nonReentrant returns (uint256 id) {
        _checkNewPositionPrice(paymentToken, amount);

        if (
            expiresAt <= block.timestamp ||
            !originRegistered[nft][tokenId] ||
            _auctionActive(nft, tokenId)
        ) revert InvalidState();

        if (IERC721JNC(nft).ownerOf(tokenId) == msg.sender) revert Unauthorized();

        _pullPayment(paymentToken, msg.sender, amount);

        id = ++nextOfferId;
        offers[id] = Offer(
            nft,
            tokenId,
            msg.sender,
            paymentToken,
            amount,
            expiresAt,
            true
        );

        uint256[] storage ids = _offerIds[nft][tokenId];
        ids.push(id);
        _offerPos[id] = ids.length;

        emit OfferCreated(
            id,
            nft,
            tokenId,
            msg.sender,
            paymentToken,
            amount,
            expiresAt
        );
    }

    function cancelOffer(uint256 id) external nonReentrant {
        Offer storage offer = offers[id];
        if (!offer.active || offer.buyer != msg.sender) revert Unauthorized();

        uint256 amount = offer.amount;
        address buyer = offer.buyer;
        address nft = offer.nftContract;
        uint256 tokenId = offer.tokenId;
        address paymentToken = offer.paymentToken;

        _removeOffer(id, offer);
        _pushPayment(paymentToken, buyer, amount);

        emit OfferCancelled(
            id,
            nft,
            tokenId,
            buyer,
            paymentToken,
            amount
        );
    }

    function acceptOffer(uint256 id) external nonReentrant {
        Offer storage offer = offers[id];

        if (
            !offer.active ||
            block.timestamp >= offer.expiresAt ||
            _auctionActive(offer.nftContract, offer.tokenId) ||
            msg.sender == offer.buyer
        ) revert InvalidState();

        IERC721JNC token = IERC721JNC(offer.nftContract);
        _requireOwnerApproved(token, offer.tokenId, msg.sender);

        Sale memory sale = _sale(
            offer.nftContract,
            offer.tokenId,
            msg.sender,
            offer.buyer,
            offer.paymentToken,
            offer.amount
        );

        _removeOffer(id, offer);
        _cancelListingByNFT(sale.nft, sale.tokenId);
        _settle(sale, sale.seller, 1, id);
    }

    function getActiveOfferIdsByNFT(
        address nft,
        uint256 tokenId
    ) external view returns (uint256[] memory) {
        return _offerIds[nft][tokenId];
    }

    function isOfferExpired(uint256 id) external view returns (bool) {
        Offer storage offer = offers[id];
        return offer.active && block.timestamp >= offer.expiresAt;
    }

    // ---------------------------------------------------------------------
    // Auction
    // ---------------------------------------------------------------------

    function createAuction(
        address nft,
        uint256 tokenId,
        uint256 reservePrice,
        uint256 buyNowPrice,
        uint64 startAt,
        uint32 durationDays,
        address paymentToken
    ) external nonReentrant returns (uint256 id) {
        _checkNewPositionPrice(paymentToken, reservePrice);

        if (buyNowPrice != 0) {
            _checkNewPositionPrice(paymentToken, buyNowPrice);
            if (buyNowPrice <= reservePrice) revert InvalidInput();
        }

        if (
            startAt < block.timestamp ||
            durationDays == 0 ||
            durationDays > 30 ||
            _auctionActive(nft, tokenId) ||
            _offerIds[nft][tokenId].length != 0
        ) revert InvalidState();

        uint256 calculatedEnd =
            uint256(startAt) + uint256(durationDays) * 1 days;

        if (calculatedEnd > type(uint64).max) revert InvalidInput();
        uint64 endsAt = uint64(calculatedEnd);

        IERC721JNC token = IERC721JNC(nft);
        _requireOwnerApproved(token, tokenId, msg.sender);
        _registerIfNeeded(nft, tokenId, msg.sender);
        _cancelListingByNFT(nft, tokenId);

        uint256 minimumBidIncrement =
            paymentTokenConfigs[paymentToken].minimumPaymentAmount;

        id = ++nextAuctionId;

        _auctions[id] = Auction(
            nft,
            tokenId,
            msg.sender,
            paymentToken,
            reservePrice,
            buyNowPrice,
            0,
            minimumBidIncrement,
            address(0),
            startAt,
            endsAt,
            durationDays,
            true
        );

        auctionIdByNFT[nft][tokenId] = id;

        token.safeTransferFrom(msg.sender, address(this), tokenId);

        emit AuctionCreated(
            id,
            nft,
            tokenId,
            msg.sender,
            paymentToken
        );
        emit AuctionTerms(
            id,
            reservePrice,
            buyNowPrice,
            minimumBidIncrement,
            startAt,
            endsAt,
            durationDays
        );
    }

    function bid(uint256 id, uint256 amount) external nonReentrant {
        Auction storage auction = _auctions[id];

        if (
            !auction.active ||
            block.timestamp < auction.startAt ||
            block.timestamp >= auction.endsAt ||
            msg.sender == auction.seller
        ) revert InvalidState();

        uint256 minimumBid = auction.highestBid == 0
            ? auction.reservePrice
            : auction.highestBid + auction.minimumBidIncrement;

        if (amount < minimumBid) revert BelowMinimum();

        if (
            auction.buyNowPrice != 0 &&
            amount >= auction.buyNowPrice
        ) revert InvalidState();

        _pullPayment(auction.paymentToken, msg.sender, amount);

        if (auction.highestBidder != address(0)) {
            pendingBidRefunds[auction.paymentToken][auction.highestBidder]
                += auction.highestBid;
        }

        auction.highestBid = amount;
        auction.highestBidder = msg.sender;

        if (auction.endsAt - block.timestamp <= ANTI_SNIPING_WINDOW) {
            uint64 previousEndsAt = auction.endsAt;
            auction.endsAt =
                uint64(block.timestamp + ANTI_SNIPING_EXTENSION);

            emit AuctionExtended(
                id,
                previousEndsAt,
                auction.endsAt
            );
        }

        emit AuctionBidPlaced(
            id,
            msg.sender,
            auction.paymentToken,
            amount
        );
    }

    function buyNowAuction(uint256 id) external nonReentrant {
        Auction storage auction = _auctions[id];

        if (
            !auction.active ||
            auction.buyNowPrice == 0 ||
            block.timestamp < auction.startAt ||
            block.timestamp >= auction.endsAt ||
            msg.sender == auction.seller
        ) revert InvalidState();

        address nft = auction.nftContract;
        uint256 tokenId = auction.tokenId;
        address seller = auction.seller;
        address paymentToken = auction.paymentToken;
        uint256 price = auction.buyNowPrice;
        address previousBidder = auction.highestBidder;
        uint256 previousBid = auction.highestBid;

        _pullPayment(paymentToken, msg.sender, price);
        _clearAuction(auction);

        if (previousBidder != address(0)) {
            pendingBidRefunds[paymentToken][previousBidder] += previousBid;
        }

        _settle(
            _sale(
                nft,
                tokenId,
                seller,
                msg.sender,
                paymentToken,
                price
            ),
            address(this),
            3,
            id
        );

        emit AuctionBuyNowCompleted(
            id,
            msg.sender,
            paymentToken,
            price
        );
    }

    function withdrawBidRefund(
        address paymentToken
    ) external nonReentrant {
        uint256 amount =
            pendingBidRefunds[paymentToken][msg.sender];

        if (amount == 0) revert InvalidState();

        pendingBidRefunds[paymentToken][msg.sender] = 0;
        _pushPayment(paymentToken, msg.sender, amount);

        emit BidRefundWithdrawn(
            msg.sender,
            paymentToken,
            amount
        );
    }

    function cancelAuction(uint256 id) external nonReentrant {
        Auction storage auction = _auctions[id];

        if (
            !auction.active ||
            auction.seller != msg.sender ||
            auction.highestBidder != address(0)
        ) revert InvalidState();

        address nft = auction.nftContract;
        uint256 tokenId = auction.tokenId;
        address seller = auction.seller;

        _clearAuction(auction);
        IERC721JNC(nft).safeTransferFrom(
            address(this),
            seller,
            tokenId
        );

        emit AuctionCancelled(id, nft, tokenId);
    }

    function finalizeAuction(uint256 id) external nonReentrant {
        Auction storage auction = _auctions[id];

        if (
            !auction.active ||
            block.timestamp < auction.endsAt
        ) revert InvalidState();

        address nft = auction.nftContract;
        uint256 tokenId = auction.tokenId;
        address seller = auction.seller;
        address winner = auction.highestBidder;
        address paymentToken = auction.paymentToken;
        uint256 amount = auction.highestBid;

        _clearAuction(auction);

        if (winner == address(0)) {
            IERC721JNC(nft).safeTransferFrom(
                address(this),
                seller,
                tokenId
            );
            emit AuctionCancelled(id, nft, tokenId);
        } else {
            _settle(
                _sale(
                    nft,
                    tokenId,
                    seller,
                    winner,
                    paymentToken,
                    amount
                ),
                address(this),
                2,
                id
            );
        }
    }

    function getAuctionCore(uint256 id)
        external
        view
        returns (
            address nftContract,
            uint256 tokenId,
            address seller,
            address paymentToken,
            uint256 reservePrice,
            uint256 buyNowPrice,
            bool active
        )
    {
        Auction storage auction = _auctions[id];
        return (
            auction.nftContract,
            auction.tokenId,
            auction.seller,
            auction.paymentToken,
            auction.reservePrice,
            auction.buyNowPrice,
            auction.active
        );
    }

    function getAuctionBidState(uint256 id)
        external
        view
        returns (
            uint256 highestBid,
            uint256 minimumBidIncrement,
            address highestBidder,
            uint64 startAt,
            uint64 endsAt,
            uint32 durationDays
        )
    {
        Auction storage auction = _auctions[id];
        return (
            auction.highestBid,
            auction.minimumBidIncrement,
            auction.highestBidder,
            auction.startAt,
            auction.endsAt,
            auction.durationDays
        );
    }

    function isAuctionStarted(uint256 id) external view returns (bool) {
        Auction storage auction = _auctions[id];
        return auction.active && block.timestamp >= auction.startAt;
    }

    function isAuctionEnded(uint256 id) external view returns (bool) {
        Auction storage auction = _auctions[id];
        return auction.active && block.timestamp >= auction.endsAt;
    }

    // ---------------------------------------------------------------------
    // Settlement
    // ---------------------------------------------------------------------

    function _sale(
        address nft,
        uint256 tokenId,
        address seller,
        address buyer,
        address paymentToken,
        uint256 price
    ) internal view returns (Sale memory sale) {
        if (!originRegistered[nft][tokenId]) revert InvalidState();

        address creator = originalCreator[nft][tokenId];
        if (creator == address(0)) revert InvalidState();

        sale = Sale(
            nft,
            tokenId,
            seller,
            buyer,
            creator,
            paymentToken,
            price,
            primarySaleCompleted[nft][tokenId]
        );
    }

    function _settle(
        Sale memory sale,
        address nftHolder,
        uint8 saleType,
        uint256 referenceId
    ) internal {
        uint256 fee =
            sale.price * feeBps / 10_000;

        uint256 royalty =
            sale.resale
                ? sale.price * royaltyBps / 10_000
                : 0;

        uint256 sellerAmount =
            sale.price - fee - royalty;

        if (!sale.resale) {
            primarySaleCompleted[sale.nft][sale.tokenId] = true;
        }

        IERC721JNC(sale.nft).safeTransferFrom(
            nftHolder,
            sale.buyer,
            sale.tokenId
        );

        _pushPayment(
            sale.paymentToken,
            feeWallet,
            fee
        );

        if (royalty != 0) {
            _pushPayment(
                sale.paymentToken,
                sale.creator,
                royalty
            );
        }

        _pushPayment(
            sale.paymentToken,
            sale.seller,
            sellerAmount
        );

        emit SaleCompleted(
            saleType,
            referenceId,
            sale.nft,
            sale.tokenId,
            sale.seller,
            sale.buyer,
            sale.paymentToken,
            sale.price,
            sale.resale
        );
    }

    // ---------------------------------------------------------------------
    // Internal market helpers
    // ---------------------------------------------------------------------

    function _requireOwnerApproved(
        IERC721JNC token,
        uint256 tokenId,
        address owner
    ) internal view {
        if (token.ownerOf(tokenId) != owner) revert NotOwner();

        if (
            token.getApproved(tokenId) != address(this) &&
            !token.isApprovedForAll(owner, address(this))
        ) revert NotApproved();
    }

    function _checkNewPositionPrice(
        address paymentToken,
        uint256 amount
    ) internal view {
        PaymentTokenConfig storage config =
            paymentTokenConfigs[paymentToken];

        if (!config.configured) {
            revert PaymentTokenNotConfigured();
        }

        if (!config.enabled) {
            revert PaymentTokenDisabled();
        }

        if (amount < config.minimumPaymentAmount) {
            revert BelowMinimum();
        }
    }

    function _auctionActive(
        address nft,
        uint256 tokenId
    ) internal view returns (bool) {
        uint256 id = auctionIdByNFT[nft][tokenId];
        return id != 0 && _auctions[id].active;
    }

    function _clearListing(
        Listing storage listing
    ) internal {
        listing.active = false;
        listingIdByNFT[
            listing.nftContract
        ][listing.tokenId] = 0;
    }

    function _cancelListing(
        uint256 id,
        Listing storage listing
    ) internal {
        address nft = listing.nftContract;
        uint256 tokenId = listing.tokenId;

        _clearListing(listing);
        emit ListingCancelled(id, nft, tokenId);
    }

    function _cancelListingByNFT(
        address nft,
        uint256 tokenId
    ) internal {
        uint256 id =
            listingIdByNFT[nft][tokenId];

        if (
            id != 0 &&
            listings[id].active
        ) {
            _cancelListing(id, listings[id]);
        }
    }

    function _clearAuction(
        Auction storage auction
    ) internal {
        auction.active = false;

        auctionIdByNFT[
            auction.nftContract
        ][auction.tokenId] = 0;
    }

    function _removeOffer(
        uint256 id,
        Offer storage offer
    ) internal {
        offer.active = false;

        uint256 position = _offerPos[id];
        if (position == 0) revert InvalidState();

        uint256[] storage ids =
            _offerIds[
                offer.nftContract
            ][offer.tokenId];

        uint256 index = position - 1;
        uint256 lastIndex = ids.length - 1;

        if (index != lastIndex) {
            uint256 movedId = ids[lastIndex];
            ids[index] = movedId;
            _offerPos[movedId] = position;
        }

        ids.pop();
        delete _offerPos[id];
    }

    function _registerIfNeeded(
        address nft,
        uint256 tokenId,
        address creator
    ) internal {
        if (!originRegistered[nft][tokenId]) {
            _register(
                nft,
                tokenId,
                creator,
                false
            );
        }
    }

    function _register(
        address nft,
        uint256 tokenId,
        address creator,
        bool completed
    ) internal {
        if (
            nft == address(0) ||
            creator == address(0)
        ) revert InvalidInput();

        if (
            originRegistered[nft][tokenId]
        ) revert InvalidState();

        originalCreator[nft][tokenId] = creator;
        primarySaleCompleted[nft][tokenId] = completed;
        originRegistered[nft][tokenId] = true;

        emit NFTOriginRegistered(
            nft,
            tokenId,
            creator,
            completed
        );
    }

    // ---------------------------------------------------------------------
    // ERC20 transfers
    // ---------------------------------------------------------------------

    function _pullPayment(
        address paymentToken,
        address from,
        uint256 amount
    ) internal {
        if (
            paymentToken == address(0) ||
            amount == 0
        ) revert InvalidInput();

        IERC20JNC token = IERC20JNC(paymentToken);

        if (
            token.balanceOf(from) < amount
        ) revert InsufficientBalance();

        if (
            token.allowance(from, address(this)) < amount
        ) revert InsufficientAllowance();

        uint256 beforeBalance =
            token.balanceOf(address(this));

        _callOptionalReturn(
            paymentToken,
            abi.encodeWithSelector(
                IERC20JNC.transferFrom.selector,
                from,
                address(this),
                amount
            )
        );

        uint256 afterBalance =
            token.balanceOf(address(this));

        if (
            afterBalance < beforeBalance ||
            afterBalance - beforeBalance != amount
        ) {
            revert UnsupportedPaymentToken();
        }
    }

    function _pushPayment(
        address paymentToken,
        address to,
        uint256 amount
    ) internal {
        if (amount == 0) return;

        if (
            paymentToken == address(0) ||
            to == address(0)
        ) revert InvalidInput();

        _callOptionalReturn(
            paymentToken,
            abi.encodeWithSelector(
                IERC20JNC.transfer.selector,
                to,
                amount
            )
        );
    }

    function _callOptionalReturn(
        address paymentToken,
        bytes memory data
    ) internal {
        (bool success, bytes memory result) =
            paymentToken.call(data);

        if (!success) revert TransferFailed();

        if (
            result.length != 0 &&
            !abi.decode(result, (bool))
        ) revert TransferFailed();
    }

    // ---------------------------------------------------------------------
    // Admin configuration
    // ---------------------------------------------------------------------

    function configurePaymentToken(
        address paymentToken,
        uint256 floorPaymentAmount,
        uint256 minimumPaymentAmount,
        bool enabled
    ) external onlyFeeWallet {
        if (
            paymentToken == address(0) ||
            paymentToken.code.length == 0 ||
            floorPaymentAmount == 0 ||
            minimumPaymentAmount < floorPaymentAmount
        ) revert InvalidInput();

        if (paymentTokenConfigs[paymentToken].configured) {
            revert PaymentTokenAlreadyConfigured();
        }

        paymentTokenConfigs[paymentToken] =
            PaymentTokenConfig({
                configured: true,
                enabled: enabled,
                floorPaymentAmount: floorPaymentAmount,
                minimumPaymentAmount: minimumPaymentAmount
            });

        emit PaymentTokenConfigured(
            paymentToken,
            floorPaymentAmount,
            minimumPaymentAmount,
            enabled
        );
    }

    function setPaymentTokenEnabled(
        address paymentToken,
        bool enabled
    ) external onlyFeeWallet {
        PaymentTokenConfig storage config =
            paymentTokenConfigs[paymentToken];

        if (!config.configured) {
            revert PaymentTokenNotConfigured();
        }

        config.enabled = enabled;

        emit PaymentTokenConfigured(
            paymentToken,
            config.floorPaymentAmount,
            config.minimumPaymentAmount,
            enabled
        );
    }

    function updatePaymentTokenMinimum(
        address paymentToken,
        uint256 minimumPaymentAmount
    ) external onlyFeeWallet {
        PaymentTokenConfig storage config =
            paymentTokenConfigs[paymentToken];

        if (!config.configured) {
            revert PaymentTokenNotConfigured();
        }

        if (minimumPaymentAmount < config.floorPaymentAmount) {
            revert BelowMinimum();
        }

        config.minimumPaymentAmount =
            minimumPaymentAmount;

        emit PaymentTokenConfigured(
            paymentToken,
            config.floorPaymentAmount,
            minimumPaymentAmount,
            config.enabled
        );
    }

    function getPaymentTokenLimits(
        address paymentToken
    ) external view returns (
        uint256 floorPaymentAmount,
        uint256 minimumPaymentAmount,
        bool enabled
    ) {
        PaymentTokenConfig storage config =
            paymentTokenConfigs[paymentToken];

        if (!config.configured) {
            revert PaymentTokenNotConfigured();
        }

        return (
            config.floorPaymentAmount,
            config.minimumPaymentAmount,
            config.enabled
        );
    }

    function updateFeeWallet(
        address value
    ) external onlyFeeWallet {
        if (value == address(0)) {
            revert InvalidInput();
        }

        feeWallet = value;
        emit ConfigUpdated(0, value, 0);
    }

    function updateFeeBps(
        uint16 value
    ) external onlyFeeWallet {
        _checkRates(value, royaltyBps);

        feeBps = value;
        emit ConfigUpdated(
            1,
            address(0),
            value
        );
    }

    function updateRoyaltyBps(
        uint16 value
    ) external onlyFeeWallet {
        _checkRates(feeBps, value);

        royaltyBps = value;
        emit ConfigUpdated(
            2,
            address(0),
            value
        );
    }

    function _checkRates(
        uint16 feeRate,
        uint16 royaltyRate
    ) internal pure {
        if (
            feeRate > 2_000 ||
            royaltyRate > 2_000 ||
            uint256(feeRate) + royaltyRate > 3_000
        ) revert InvalidInput();
    }

    function onERC721Received(
        address,
        address,
        uint256,
        bytes calldata
    ) external pure returns (bytes4) {
        return 0x150b7a02;
    }
}
