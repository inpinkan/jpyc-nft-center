// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/*
    JNCMarketplace_v2.24.1_MultiToken_ERC20

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
    - Auction bid increment is configured independently per payment token and snapshotted when the auction is created.
    - Verified origins are registered explicitly; historical sale status remains readable.
    - NFT origins require fee-wallet verification; ownership alone never proves creator identity.
    - Previous-market sale state is read across a bounded, deployment-time source list.
    - Sales distribute ERC20 proceeds immediately; auction finalization also delivers the NFT.
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

interface IJNCMarketplaceOrigin {
    function originRegistered(address nft, uint256 tokenId) external view returns (bool);
    function originalCreator(address nft, uint256 tokenId) external view returns (address);
    function primarySaleCompleted(address nft, uint256 tokenId) external view returns (bool);
}

contract JNCMarketplace {
    struct PaymentTokenConfig {
        bool configured;
        bool enabled;
        uint256 floorPaymentAmount;
        uint256 minimumPaymentAmount;
        uint256 minimumBidIncrement;
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

    struct RateConfig {
        uint16 fee;
        uint16 royalty;
        address recipient;
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
        RateConfig rates;
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
    error OriginVerificationRequired();
    error NewPositionsPaused();

    uint256 public constant marketplaceVersion = 22401;
    bool public newPositionsEnabled;
    address public pendingFeeWallet;
    address[] public legacyMarketplaces;


    mapping(address => mapping(uint256 => uint256)) public heldAuctionByNFT;
    mapping(uint256 => RateConfig) private _listingRates;
    mapping(uint256 => RateConfig) private _offerRates;
    mapping(uint256 => RateConfig) private _auctionRates;
    address private _expectedNFT;
    address private _expectedFrom;
    uint256 private _expectedTokenId;

    event NewPositionsEnabled(bool enabled);
    event FeeWalletProposed(address indexed current, address indexed proposed);




    event LegacySourceAdded(address indexed source);

    address public feeWallet;
    address public immutable previousMarketplace;
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
    mapping(address => mapping(uint256 => bool)) private _primarySaleCompleted;
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
        uint256 minimumBidIncrement,
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
        previousMarketplace is the immediately preceding JNC Marketplace on the same chain.
        It is used only to preserve existing NFT creator / primary-sale state during migration.
        Use address(0) only when there is no previous Marketplace to import from.
    */
    constructor(
        address initialPaymentToken,
        address initialFeeWallet,
        uint16 initialFeeBps,
        uint16 initialRoyaltyBps,
        uint256 initialFloorPaymentAmount,
        address initialPreviousMarketplace,
        address[] memory additionalLegacyMarketplaces
    ) {
        if (
            initialPaymentToken == address(0) ||
            initialPaymentToken.code.length == 0 ||
            initialFeeWallet == address(0) ||
            initialFloorPaymentAmount == 0 ||
            (
                initialPreviousMarketplace != address(0) &&
                initialPreviousMarketplace.code.length == 0
            )
        ) revert InvalidInput();

        _checkRates(initialFeeBps, initialRoyaltyBps);

        feeWallet = initialFeeWallet;
        previousMarketplace = initialPreviousMarketplace;
        if (initialPreviousMarketplace != address(0)) {
            legacyMarketplaces.push(initialPreviousMarketplace);
            emit LegacySourceAdded(initialPreviousMarketplace);
        }
        if (additionalLegacyMarketplaces.length > 7) revert InvalidInput();
        for (uint256 i; i < additionalLegacyMarketplaces.length; ++i) {
            address source = additionalLegacyMarketplaces[i];
            if (source == address(0) || source.code.length == 0) revert InvalidInput();
            for (uint256 j; j < legacyMarketplaces.length; ++j) {
                if (legacyMarketplaces[j] == source) revert InvalidInput();
            }
            legacyMarketplaces.push(source);
            emit LegacySourceAdded(source);
        }
        feeBps = initialFeeBps;
        royaltyBps = initialRoyaltyBps;

        paymentTokenConfigs[initialPaymentToken] = PaymentTokenConfig({
            configured: true,
            enabled: true,
            floorPaymentAmount: initialFloorPaymentAmount,
            minimumPaymentAmount: initialFloorPaymentAmount,
            minimumBidIncrement: initialFloorPaymentAmount
        });

        emit PaymentTokenConfigured(
            initialPaymentToken,
            initialFloorPaymentAmount,
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

    // Retained ABI: an owner can synchronize a verified origin, never self-assign one.
    function registerNFTOriginByOwner(address nft, uint256 tokenId) external nonReentrant {
        if (IERC721JNC(nft).ownerOf(tokenId) != msg.sender) revert NotOwner();
        if (!originRegistered[nft][tokenId]) revert OriginVerificationRequired();
        if (primarySaleCompleted(nft, tokenId)) _primarySaleCompleted[nft][tokenId] = true;
    }

    function primarySaleCompleted(address nft, uint256 tokenId) public view returns (bool) {
        return _primarySaleCompleted[nft][tokenId] || _legacySaleCompleted(nft, tokenId);
    }

    function legacyMarketplaceCount() external view returns (uint256) {
        return legacyMarketplaces.length;
    }

    // ---------------------------------------------------------------------
    // Listing
    // ---------------------------------------------------------------------

    function createListing(
        address nft,
        uint256 tokenId,
        uint256 price,
        address paymentToken
    ) external nonReentrant returns (uint256 id) {
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
        _listingRates[id] = _currentRates();

        emit ListingCreated(
            id,
            nft,
            tokenId,
            msg.sender,
            paymentToken,
            price
        );
    }

    function cancelListing(uint256 id) external nonReentrant {
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
            listing.price,
            _listingRates[id]
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

        _offerRates[id] = _currentRates();
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
        _cancelOfferTo(id, msg.sender);
    }

    function cancelOfferTo(uint256 id, address recipient) external nonReentrant {
        _cancelOfferTo(id, recipient);
    }

    function _cancelOfferTo(uint256 id, address recipient) internal {
        if (recipient == address(0) || recipient == address(this)) revert InvalidInput();
        Offer storage offer = offers[id];
        if (!offer.active || offer.buyer != msg.sender) revert Unauthorized();

        uint256 amount = offer.amount;
        address buyer = offer.buyer;
        address nft = offer.nftContract;
        uint256 tokenId = offer.tokenId;
        address paymentToken = offer.paymentToken;

        _removeOffer(id, offer);
        _pushPayment(paymentToken, recipient, amount);

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
            offer.amount,
            _offerRates[id]
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
            _auctionActive(nft, tokenId)
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
            paymentTokenConfigs[paymentToken].minimumBidIncrement;

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

        _auctionRates[id] = _currentRates();
        heldAuctionByNFT[nft][tokenId] = id;
        _expectedNFT = nft;
        _expectedFrom = msg.sender;
        _expectedTokenId = tokenId;
        token.safeTransferFrom(msg.sender, address(this), tokenId);
        delete _expectedNFT;
        delete _expectedFrom;
        delete _expectedTokenId;

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

        Sale memory sale = _sale(
            auction.nftContract, auction.tokenId, auction.seller, msg.sender,
            auction.paymentToken, auction.buyNowPrice, _auctionRates[id]
        );
        _pullPayment(sale.paymentToken, msg.sender, sale.price);
        _clearAuction(auction);

        if (auction.highestBidder != address(0)) {
            pendingBidRefunds[sale.paymentToken][auction.highestBidder] += auction.highestBid;
        }

        _settle(sale, address(this), 3, id);

        emit AuctionBuyNowCompleted(
            id,
            msg.sender,
            sale.paymentToken,
            sale.price
        );
    }

    function withdrawBidRefund(
        address paymentToken
    ) external nonReentrant {
        _withdrawBidRefundTo(paymentToken, msg.sender);
    }

    function withdrawBidRefundTo(address paymentToken, address recipient) external nonReentrant {
        _withdrawBidRefundTo(paymentToken, recipient);
    }

    function _withdrawBidRefundTo(address paymentToken, address recipient) internal {
        if (recipient == address(0) || recipient == address(this)) revert InvalidInput();
        uint256 amount = pendingBidRefunds[paymentToken][msg.sender];

        if (amount == 0) revert InvalidState();

        pendingBidRefunds[paymentToken][msg.sender] = 0;
        _pushPayment(paymentToken, recipient, amount);

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
        delete heldAuctionByNFT[nft][tokenId];
        IERC721JNC(nft).safeTransferFrom(address(this), seller, tokenId);

        emit AuctionCancelled(id, nft, tokenId);
    }

    function finalizeAuction(uint256 id) external nonReentrant {
        Auction storage auction = _auctions[id];

        if (
            !auction.active ||
            block.timestamp < auction.endsAt
        ) revert InvalidState();

        _clearAuction(auction);

        if (auction.highestBidder == address(0)) {
            delete heldAuctionByNFT[auction.nftContract][auction.tokenId];
            IERC721JNC(auction.nftContract).safeTransferFrom(address(this), auction.seller, auction.tokenId);
            emit AuctionCancelled(id, auction.nftContract, auction.tokenId);
        } else {
            _settle(
                _sale(
                    auction.nftContract,
                    auction.tokenId,
                    auction.seller,
                    auction.highestBidder,
                    auction.paymentToken,
                    auction.highestBid,
                    _auctionRates[id]
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


    // ---------------------------------------------------------------------
    // Settlement
    // ---------------------------------------------------------------------

    function _sale(
        address nft,
        uint256 tokenId,
        address seller,
        address buyer,
        address paymentToken,
        uint256 price,
        RateConfig memory rates
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
            primarySaleCompleted(nft, tokenId) || seller != creator,
            rates
        );
    }

    function _settle(
        Sale memory sale,
        address nftHolder,
        uint8 saleType,
        uint256 referenceId
    ) internal {
        uint256 fee =
            sale.price * sale.rates.fee / 10_000;

        uint256 royalty =
            sale.resale
                ? sale.price * sale.rates.royalty / 10_000
                : 0;

        uint256 sellerAmount =
            sale.price - fee - royalty;

        _primarySaleCompleted[sale.nft][sale.tokenId] = true;

        if (nftHolder == address(this)) delete heldAuctionByNFT[sale.nft][sale.tokenId];
        IERC721JNC(sale.nft).safeTransferFrom(nftHolder, sale.buyer, sale.tokenId);

        _pushPayment(sale.paymentToken, sale.rates.recipient, fee);
        if (royalty != 0) _pushPayment(sale.paymentToken, sale.creator, royalty);
        _pushPayment(sale.paymentToken, sale.seller, sellerAmount);

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
        if (!newPositionsEnabled) revert NewPositionsPaused();
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

    function _registerIfNeeded(address nft, uint256 tokenId, address) internal view {
        if (!originRegistered[nft][tokenId]) revert OriginVerificationRequired();
    }

    // Fail closed if a configured historical source cannot be read. The source list
    // is fixed at deployment and bounded to eight contracts, avoiding unbounded walks.
    function _legacySaleCompleted(address nft, uint256 tokenId) internal view returns (bool) {
        for (uint256 i; i < legacyMarketplaces.length; ++i) {
            IJNCMarketplaceOrigin legacy = IJNCMarketplaceOrigin(legacyMarketplaces[i]);
            if (legacy.originRegistered(nft, tokenId) && legacy.primarySaleCompleted(nft, tokenId)) return true;
        }
        return false;
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

        // Verify that the NFT exists before an irreversible admin registration.
        IERC721JNC(nft).ownerOf(tokenId);
        originalCreator[nft][tokenId] = creator;
        _primarySaleCompleted[nft][tokenId] = completed || _legacySaleCompleted(nft, tokenId);
        originRegistered[nft][tokenId] = true;

        emit NFTOriginRegistered(
            nft,
            tokenId,
            creator,
            _primarySaleCompleted[nft][tokenId]
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
        uint256 minimumBidIncrement,
        bool enabled
    ) external onlyFeeWallet {
        if (
            paymentToken == address(0) ||
            paymentToken.code.length == 0 ||
            floorPaymentAmount == 0 ||
            minimumPaymentAmount < floorPaymentAmount ||
            minimumBidIncrement == 0
        ) revert InvalidInput();

        if (paymentTokenConfigs[paymentToken].configured) {
            revert PaymentTokenAlreadyConfigured();
        }

        paymentTokenConfigs[paymentToken] =
            PaymentTokenConfig({
                configured: true,
                enabled: enabled,
                floorPaymentAmount: floorPaymentAmount,
                minimumPaymentAmount: minimumPaymentAmount,
                minimumBidIncrement: minimumBidIncrement
            });

        emit PaymentTokenConfigured(
            paymentToken,
            floorPaymentAmount,
            minimumPaymentAmount,
            minimumBidIncrement,
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
            config.minimumBidIncrement,
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
            config.minimumBidIncrement,
            config.enabled
        );
    }

    function updatePaymentTokenBidIncrement(
        address paymentToken,
        uint256 minimumBidIncrement
    ) external onlyFeeWallet {
        PaymentTokenConfig storage config =
            paymentTokenConfigs[paymentToken];

        if (!config.configured) {
            revert PaymentTokenNotConfigured();
        }

        if (minimumBidIncrement == 0) {
            revert InvalidInput();
        }

        config.minimumBidIncrement =
            minimumBidIncrement;

        emit PaymentTokenConfigured(
            paymentToken,
            config.floorPaymentAmount,
            config.minimumPaymentAmount,
            minimumBidIncrement,
            config.enabled
        );
    }

    function getPaymentTokenLimits(
        address paymentToken
    ) external view returns (
        uint256 floorPaymentAmount,
        uint256 minimumPaymentAmount,
        uint256 minimumBidIncrement,
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
            config.minimumBidIncrement,
            config.enabled
        );
    }

    function updateFeeWallet(
        address value
    ) external onlyFeeWallet {
        if (value == address(0)) {
            revert InvalidInput();
        }

        pendingFeeWallet = value;
        emit FeeWalletProposed(feeWallet, value);
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

    function acceptFeeWallet() external {
        if (msg.sender != pendingFeeWallet) revert Unauthorized();
        feeWallet = msg.sender;
        delete pendingFeeWallet;
        emit ConfigUpdated(0, msg.sender, 0);
    }

    function setNewPositionsEnabled(bool enabled) external onlyFeeWallet {
        newPositionsEnabled = enabled;
        emit NewPositionsEnabled(enabled);
    }

    function _currentRates() internal view returns (RateConfig memory) {
        return RateConfig(feeBps, royaltyBps, feeWallet);
    }

    function onERC721Received(address operator, address from, uint256 tokenId, bytes calldata)
        external view returns (bytes4)
    {
        if (msg.sender != _expectedNFT || from != _expectedFrom ||
            tokenId != _expectedTokenId || operator != address(this)) revert InvalidState();
        return 0x150b7a02;
    }
}
