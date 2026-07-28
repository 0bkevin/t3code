import ExpoModulesCore
import Foundation

// WebSocket client backed by URLSessionWebSocketTask. React Native's built-in
// iOS WebSocket (SocketRocket) never offers permessage-deflate, so frames from
// the T3 server arrive uncompressed. URLSessionWebSocketTask offers the
// extension in its handshake by default, letting the server (which negotiates
// permessage-deflate since #4705) compress the JSON RPC stream.
//
// Only the surface Effect's `Socket.fromWebSocket` needs is exposed: connect,
// send text/binary, close, and open/message/close/error events routed by a
// JS-assigned connection id.
public final class T3WebSocketModule: Module {
  private let connections = T3WebSocketConnections()

  public func definition() -> ModuleDefinition {
    Name("T3WebSocket")

    Events("onOpen", "onMessage", "onClose", "onError")

    Function("connect") { (id: Int, url: String, protocols: [String]) throws in
      guard let parsedUrl = URL(string: url) else {
        throw Exception(name: "InvalidUrl", description: "Invalid WebSocket URL: \(url)")
      }
      self.connections.open(id: id, url: parsedUrl, protocols: protocols) { [weak self] event, payload in
        self?.sendEvent(event, payload)
      }
    }

    Function("sendText") { (id: Int, text: String) in
      self.connections.send(id: id, message: .string(text))
    }

    Function("sendBinary") { (id: Int, base64: String) in
      guard let data = Data(base64Encoded: base64) else { return }
      self.connections.send(id: id, message: .data(data))
    }

    Function("close") { (id: Int, code: Int, reason: String) in
      self.connections.close(id: id, code: code, reason: reason)
    }

    OnDestroy {
      self.connections.cancelAll()
    }
  }
}

private typealias T3WebSocketEmitter = (_ event: String, _ payload: [String: Any]) -> Void

private final class T3WebSocketConnections: NSObject, URLSessionWebSocketDelegate {
  // Snapshot frames on the socket-fallback path can reach tens of MB; the
  // URLSession default receive cap is 1 MB, which would abort the connection.
  private static let maximumMessageSize = 128 * 1024 * 1024

  private let queue = DispatchQueue(label: "com.t3tools.t3code.websocket")
  private var tasksById: [Int: URLSessionWebSocketTask] = [:]
  private var idsByTaskIdentifier: [Int: Int] = [:]
  private var emittersById: [Int: T3WebSocketEmitter] = [:]

  private lazy var session = URLSession(
    configuration: .default,
    delegate: self,
    delegateQueue: nil
  )

  func open(id: Int, url: URL, protocols: [String], emitter: @escaping T3WebSocketEmitter) {
    queue.async {
      let task = protocols.isEmpty
        ? self.session.webSocketTask(with: url)
        : self.session.webSocketTask(with: url, protocols: protocols)
      task.maximumMessageSize = Self.maximumMessageSize
      self.tasksById[id] = task
      self.idsByTaskIdentifier[task.taskIdentifier] = id
      self.emittersById[id] = emitter
      task.resume()
      self.receiveLoop(id: id, task: task)
    }
  }

  func send(id: Int, message: URLSessionWebSocketTask.Message) {
    queue.async {
      guard let task = self.tasksById[id] else { return }
      task.send(message) { [weak self] error in
        guard let error else { return }
        self?.emit(id: id, event: "onError", payload: ["message": error.localizedDescription])
      }
    }
  }

  func close(id: Int, code: Int, reason: String) {
    queue.async {
      guard let task = self.tasksById[id] else { return }
      let closeCode = URLSessionWebSocketTask.CloseCode(rawValue: code) ?? .normalClosure
      task.cancel(with: closeCode, reason: reason.data(using: .utf8))
    }
  }

  func cancelAll() {
    queue.async {
      for task in self.tasksById.values {
        task.cancel(with: .goingAway, reason: nil)
      }
      self.tasksById.removeAll()
      self.idsByTaskIdentifier.removeAll()
      self.emittersById.removeAll()
    }
  }

  private func receiveLoop(id: Int, task: URLSessionWebSocketTask) {
    task.receive { [weak self] result in
      guard let self else { return }
      switch result {
      case .success(let message):
        switch message {
        case .string(let text):
          self.emit(id: id, event: "onMessage", payload: ["data": text, "binary": false])
        case .data(let data):
          self.emit(id: id, event: "onMessage", payload: ["data": data.base64EncodedString(), "binary": true])
        @unknown default:
          break
        }
        self.queue.async {
          guard self.tasksById[id] != nil else { return }
          self.receiveLoop(id: id, task: task)
        }
      case .failure:
        // The delegate close/error callbacks own failure reporting; the loop
        // just stops so it does not spin on a dead task.
        break
      }
    }
  }

  private func emit(id: Int, event: String, payload: [String: Any]) {
    queue.async {
      guard let emitter = self.emittersById[id] else { return }
      var enriched = payload
      enriched["id"] = id
      emitter(event, enriched)
    }
  }

  private func remove(id: Int, taskIdentifier: Int) {
    tasksById.removeValue(forKey: id)
    idsByTaskIdentifier.removeValue(forKey: taskIdentifier)
    emittersById.removeValue(forKey: id)
  }

  // MARK: - URLSessionWebSocketDelegate

  func urlSession(
    _ session: URLSession,
    webSocketTask: URLSessionWebSocketTask,
    didOpenWithProtocol protocol: String?
  ) {
    queue.async {
      guard let id = self.idsByTaskIdentifier[webSocketTask.taskIdentifier] else { return }
      self.emit(id: id, event: "onOpen", payload: ["protocol": `protocol` ?? ""])
    }
  }

  func urlSession(
    _ session: URLSession,
    webSocketTask: URLSessionWebSocketTask,
    didCloseWith closeCode: URLSessionWebSocketTask.CloseCode,
    reason: Data?
  ) {
    queue.async {
      guard let id = self.idsByTaskIdentifier[webSocketTask.taskIdentifier] else { return }
      let reasonText = reason.flatMap { String(data: $0, encoding: .utf8) } ?? ""
      self.emit(id: id, event: "onClose", payload: ["code": closeCode.rawValue, "reason": reasonText])
      self.remove(id: id, taskIdentifier: webSocketTask.taskIdentifier)
    }
  }

  func urlSession(
    _ session: URLSession,
    task: URLSessionTask,
    didCompleteWithError error: Error?
  ) {
    queue.async {
      guard let id = self.idsByTaskIdentifier[task.taskIdentifier] else { return }
      if let error {
        self.emit(id: id, event: "onError", payload: ["message": error.localizedDescription])
        // Abnormal termination: no close frame arrived, mirror the browser's
        // 1006 so Effect's close-code classification treats it as an error.
        self.emit(id: id, event: "onClose", payload: ["code": 1006, "reason": error.localizedDescription])
      }
      self.remove(id: id, taskIdentifier: task.taskIdentifier)
    }
  }
}
