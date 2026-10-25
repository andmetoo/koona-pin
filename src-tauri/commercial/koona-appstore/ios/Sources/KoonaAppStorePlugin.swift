import StoreKit
import SwiftRs
import Tauri
import UIKit
import WebKit

// Supporter through the App Store (StoreKit 2), in the App Store build only. The app's Rust side
// (billing/appstore.rs) calls these commands, never the page. Nothing here finishes a transaction
// on its own: the app finishes one after the server has bound it, so a purchase nobody has claimed
// yet comes back in `Transaction.unfinished` on the next start.

class ProductsArgs: Decodable {
  let ids: [String]
}

class BuyArgs: Decodable {
  let product: String
  let accountToken: String
}

class TransactionsArgs: Decodable {
  let sync: Bool
}

class FinishArgs: Decodable {
  let ids: [String]
}

struct ProductFacts: Encodable {
  let id: String
  let price: String
  let currency: String
  let micros: Int64
  let period: String?
}

struct ProductsAnswer: Encodable {
  let products: [ProductFacts]
  let suspended: Bool
}

struct TransactionFacts: Encodable {
  let id: String
  let originalId: String
  let product: String
  let jws: String
  let accountToken: String?
  let revoked: Bool
  let verified: Bool
}

struct BuyAnswer: Encodable {
  let outcome: String
  let transaction: TransactionFacts?
}

struct TransactionsAnswer: Encodable {
  let unfinished: [TransactionFacts]
  let entitlements: [TransactionFacts]
}

struct Reported: Encodable {
  let transactions: [TransactionFacts]
}

/// A transaction as the app reads it, verified by StoreKit or not: the server verifies the JWS
/// either way, and refuses one that does not verify.
func facts(_ result: VerificationResult<Transaction>) -> TransactionFacts {
  let (transaction, verified): (Transaction, Bool) = {
    switch result {
    case .verified(let transaction): return (transaction, true)
    case .unverified(let transaction, _): return (transaction, false)
    }
  }()
  return TransactionFacts(
    id: String(transaction.id),
    originalId: String(transaction.originalID),
    product: transaction.productID,
    jws: result.jwsRepresentation,
    accountToken: transaction.appAccountToken?.uuidString.lowercased(),
    revoked: transaction.revocationDate != nil,
    verified: verified
  )
}

/// ISO 8601 of a subscription's period: `P1M`, `P1Y`.
func period(_ period: Product.SubscriptionPeriod) -> String {
  let unit: String = {
    switch period.unit {
    case .day: return "D"
    case .week: return "W"
    case .month: return "M"
    case .year: return "Y"
    @unknown default: return "?"
    }
  }()
  return "P\(period.value)\(unit)"
}

class KoonaAppStorePlugin: Plugin {
  private var updates: Task<Void, Never>?

  @objc public override func load(webview: WKWebView) {
    // From the start, as Apple asks: a purchase approved later (Ask to Buy), a renewal, a refund.
    // The app also reads `Transaction.unfinished` on start, so one that arrives before its Rust
    // side listens is not lost.
    updates = Task.detached { [weak self] in
      for await result in Transaction.updates {
        let reported = Reported(transactions: [facts(result)])
        // On the main thread, where the listeners are registered.
        await MainActor.run {
          try? self?.trigger("transactions", data: reported)
        }
      }
    }
  }

  deinit {
    updates?.cancel()
  }

  @objc public func products(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(ProductsArgs.self)
    Task {
      do {
        let products = try await Product.products(for: args.ids)
        let shown = products.map { product in
          ProductFacts(
            id: product.id,
            price: product.displayPrice,
            currency: product.priceFormatStyle.currencyCode,
            micros: NSDecimalNumber(decimal: product.price * 1_000_000).int64Value,
            period: product.subscription.map { period($0.subscriptionPeriod) }
          )
        }
        // In billing retry the subscription gives no access; the payment is fixed in the App Store.
        var suspended = false
        for product in products {
          guard let subscription = product.subscription else { continue }
          let statuses = (try? await subscription.status) ?? []
          if statuses.contains(where: { $0.state == .inBillingRetryPeriod }) { suspended = true }
        }
        invoke.resolve(ProductsAnswer(products: shown, suspended: suspended))
      } catch {
        invoke.reject("The App Store's products could not be read: \(error.localizedDescription)", code: "failed")
      }
    }
  }

  @objc public func buy(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(BuyArgs.self)
    guard let token = UUID(uuidString: args.accountToken) else {
      invoke.reject("The account token is not a UUID", code: "failed")
      return
    }
    Task { @MainActor in
      if !AppStore.canMakePayments {
        invoke.reject("Purchases are not allowed on this iPhone", code: "unavailable")
        return
      }
      do {
        guard let product = try await Product.products(for: [args.product]).first else {
          invoke.reject("The App Store does not sell \(args.product) here", code: "unavailable")
          return
        }
        let result: Product.PurchaseResult
        if #available(iOS 17.0, *), let scene = self.scene() {
          result = try await product.purchase(confirmIn: scene, options: [.appAccountToken(token)])
        } else {
          result = try await product.purchase(options: [.appAccountToken(token)])
        }
        switch result {
        case .success(let verification):
          invoke.resolve(BuyAnswer(outcome: "purchased", transaction: facts(verification)))
        case .pending:
          invoke.resolve(BuyAnswer(outcome: "pending", transaction: nil))
        case .userCancelled:
          invoke.resolve(BuyAnswer(outcome: "canceled", transaction: nil))
        @unknown default:
          invoke.resolve(BuyAnswer(outcome: "error", transaction: nil))
        }
      } catch let error as Product.PurchaseError {
        switch error {
        case .productUnavailable, .purchaseNotAllowed, .ineligibleForOffer:
          invoke.reject(error.localizedDescription, code: "unavailable")
        default:
          invoke.reject(error.localizedDescription, code: "failed")
        }
      } catch let error as StoreKitError {
        switch error {
        case .userCancelled:
          invoke.resolve(BuyAnswer(outcome: "canceled", transaction: nil))
        case .notAvailableInStorefront, .notEntitled:
          invoke.reject(error.localizedDescription, code: "unavailable")
        default:
          invoke.reject(error.localizedDescription, code: "failed")
        }
      } catch {
        invoke.reject(error.localizedDescription, code: "failed")
      }
    }
  }

  @objc public func transactions(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(TransactionsArgs.self)
    Task {
      if args.sync {
        do {
          try await AppStore.sync()
        } catch StoreKitError.userCancelled {
          invoke.reject("The Apple Account sign-in was cancelled", code: "canceled")
          return
        } catch {
          invoke.reject("The App Store could not be synced: \(error.localizedDescription)", code: "failed")
          return
        }
      }
      var unfinished: [TransactionFacts] = []
      for await result in Transaction.unfinished {
        unfinished.append(facts(result))
      }
      var entitlements: [TransactionFacts] = []
      for await result in Transaction.currentEntitlements {
        entitlements.append(facts(result))
      }
      invoke.resolve(TransactionsAnswer(unfinished: unfinished, entitlements: entitlements))
    }
  }

  @objc public func finish(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(FinishArgs.self)
    Task {
      // One pass over what is unfinished, however many are asked for; done once all were found.
      var left = Set(args.ids)
      for await result in Transaction.unfinished where !left.isEmpty {
        let transaction: Transaction
        switch result {
        case .verified(let t): transaction = t
        case .unverified(let t, _): transaction = t
        }
        if left.remove(String(transaction.id)) != nil {
          await transaction.finish()
        }
      }
      invoke.resolve()
    }
  }

  @objc public func manage(_ invoke: Invoke) throws {
    Task { @MainActor in
      guard let scene = self.scene() else {
        invoke.reject("No window to show the subscriptions in", code: "failed")
        return
      }
      do {
        try await AppStore.showManageSubscriptions(in: scene)
        invoke.resolve()
      } catch {
        invoke.reject(error.localizedDescription, code: "failed")
      }
    }
  }

  @MainActor private func scene() -> UIWindowScene? {
    let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
    return scenes.first(where: { $0.activationState == .foregroundActive }) ?? scenes.first
  }
}

@_cdecl("init_plugin_koona_appstore")
func initPlugin() -> Plugin {
  return KoonaAppStorePlugin()
}
